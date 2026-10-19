// ProcessManager — the thin process abstraction for @quark/manager.
//
// Owns ONLY process lifecycle + window state. All idle/sleep policy lives in
// @quark/service; this module deliberately has no CPU sampling, no idle timer,
// no two-stage minimize/stop decisions, and no "re-adoption" heuristics beyond
// what's needed to stay authoritative about liveness.
//
// Liveness is TCP-probe of the CDP port — the only signal that survives the
// spark runtime where the `wine start.exe /Unix LNK` launcher exits early
// while Chromium keeps serving.

import { EventPublisher } from "@orpc/server";
import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import type { ProcessState, ServerStatus } from "@quark/contract/schemas";
import {
  LAUNCH_SCRIPT,
  log,
  QUARK_CDP_PORT,
  QUARK_WINDOW_TITLE,
  WINE_USER,
  WINESERVER_BIN,
} from "@quark/config";

const QUARK_HOST = "127.0.0.1";

// After a spawn the launch script (wine start.exe /Unix LNK) exits early while
// Chromium keeps booting, so the CDP port only opens seconds later. Treat a
// recent spawn as "starting" — a concurrent /start (e.g. the client's
// wake-on-connect while Quark is still booting) must not spawn a second
// instance that would fight over the shared WINEPREFIX / single-instance app.
const START_GRACE_MS = 60_000;

// Wine/Chromium user-mode process names to match on for by-name kills. Under
// Wine, QuarkCloudDrive.exe runs as Chromium's "CrBrowserMain" process, so the
// binary name never appears in the process list — we match on the Chromium
// names instead. This covers both the standard and spark runtimes.
const DEFAULT_PATTERNS = [
  "crbrowsermain",
  "crgpumain",
  "crutilitymain",
  "crrenderermain",
  "winedevice",
  "winemenubuilder",
  "services.exe",
  "plugplay",
  "svchost.exe",
  "explorer.exe",
  "rpcss.exe",
  "rundll32",
  "iexplore",
  "wineboot",
  "wineserver",
];

// Names that uniquely identify a Wine/Quark helper — name match is enough, no
// cmdline check needed. Chromium-derived names additionally require the
// cmdline to mention "quark" (defence in depth).
const NAME_ONLY = new Set([
  "wineserver",
  "winedevice",
  "winemenubuilder",
  "services.exe",
  "plugplay",
  "svchost.exe",
  "explorer.exe",
  "rpcss.exe",
  "rundll32",
  "iexplore",
  "wineboot",
]);

type ProcessEvents = {
  process: { state: ProcessState };
  activity: { at: number };
};

export class ProcessManager {
  readonly events = new EventPublisher<ProcessEvents>();

  private state: ProcessState = "stopped";
  private proc: Bun.Subprocess | null = null;
  private pgid: number | null = null;
  private startedAt: number | null = null;
  private lastCdpActivity: number | null = null;
  private lastLaunchAt: number | null = null;
  private counts = { start: 0, stop: 0, minimize: 0 };

  private readonly patterns: string[];

  constructor(opts: { extraProcessPatterns?: string[] } = {}) {
    this.patterns = [...DEFAULT_PATTERNS, ...(opts.extraProcessPatterns ?? [])];
  }

  private setState(next: ProcessState): void {
    if (this.state === next) return;
    log.info(`state ${this.state} → ${next}`);
    this.state = next;
    this.events.publish("process", { state: next });
  }

  /** Record CDP traffic (called by the proxy). */
  markActivity(): void {
    this.lastCdpActivity = Date.now();
    this.events.publish("activity", { at: this.lastCdpActivity });
  }

  // ── liveness ───────────────────────────────────────────────────────────────

  /** Authoritative check: is Chromium accepting CDP on the CDP port? */
  async chromiumListening(): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = netConnect({ host: QUARK_HOST, port: QUARK_CDP_PORT });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async isProcAlive(): Promise<boolean> {
    // `exitCode` is null while the child is still running: the same question
    // the Deno version asked of `child.status`, without waiting for the exit.
    if (this.proc && this.proc.exitCode === null) return true;
    return this.chromiumListening();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** True when the launch script exists on this host (Quark can actually start). */
  launchScriptAvailable(): boolean {
    try {
      return statSync(LAUNCH_SCRIPT).isFile();
    } catch {
      return false;
    }
  }

  async start(): Promise<ServerStatus> {
    if (await this.isProcAlive()) {
      // If Chromium is serving but we think we're minimized, restore the
      // window (idempotent). Otherwise no-op.
      if (this.state === "starting" && !(await this.chromiumListening())) {
        return this.status();
      }
      if (this.state === "running_minimized") {
        try {
          await this.restore();
        } catch (e) {
          log.warn(`start: restore of minimized window failed: ${e}`);
        }
      } else if (this.state !== "running_visible") {
        this.setState("running_visible");
      }
      return this.status();
    }

    if (!this.launchScriptAvailable()) {
      throw new Error(
        `launch script not found at "${LAUNCH_SCRIPT}" — Quark cannot be started on this host. ` +
          "Install it, set LAUNCH_SCRIPT to the real script, or run with QUARK_AUTOSTART=false.",
      );
    }

    // A launch is already in progress (Chromium still booting, CDP port not
    // yet open). Don't spawn a second instance.
    if (
      this.lastLaunchAt !== null &&
      Date.now() - this.lastLaunchAt < START_GRACE_MS
    ) {
      log.debug(
        `start: launch ${Date.now() - this.lastLaunchAt}ms ago still within ` +
          "grace window — not relaunching",
      );
      if (
        this.state !== "running_visible" && this.state !== "running_minimized"
      ) {
        this.setState("starting");
      }
      return this.status();
    }

    log.info("starting Quark via launch script");
    this.setState("starting");
    const cmd = this.buildLaunchCommand();
    try {
      this.proc = Bun.spawn([cmd.command, ...cmd.args], {
        env: { ...process.env, ...cmd.env },
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (e) {
      throw new Error(
        `launch-quark failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    // Capture the pgid (retry briefly — the kernel may not register the new
    // session leader immediately).
    this.pgid = null;
    for (let i = 0; i < 20; i++) {
      const gid = this.resolvePgid();
      if (gid !== null) {
        this.pgid = gid;
        break;
      }
      await sleep(50);
    }

    this.startedAt = Date.now();
    this.lastLaunchAt = Date.now();
    this.counts.start++;
    log.info(`Quark started (pid=${this.proc.pid} pgid=${this.pgid})`);
    return this.status();
  }

  async stop(): Promise<ServerStatus> {
    log.info("stopping Quark");
    const candidate = this.pgid ??
      (this.proc ? readProcessGroup(this.proc.pid) : null);
    const targetPgid =
      isOwnProcessGroup(candidate, readProcessGroup(process.pid))
        ? candidate
        : null;
    if (candidate !== null && targetPgid === null) {
      // The launcher inherited the container's group instead of creating its
      // own. `kill(-pgid)` would then mean `kill(0)`/`kill(-1)` and take out
      // the X server, x11vnc and everything else the entrypoint started, so
      // Quark could never start again. Stage 2/3 below still stop Quark.
      log.warn(
        `not signalling process group ${candidate}: it is not owned by the ` +
          "launcher (shared with the container init); using by-name kills only",
      );
    }

    // Stage 1: process-group kill (standard runtime).
    if (targetPgid !== null) {
      try {
        process.kill(-targetPgid, "SIGTERM");
      } catch {
        // group may already be gone
      }
    }

    // Stage 2: by-name kill (spark runtime where the wrapper exited early).
    await this.killByName("SIGTERM");

    // Wait up to 5s for everything to drain.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await this.quarkProcessesAlive())) break;
      await sleep(200);
    }

    if (targetPgid !== null) {
      try {
        process.kill(-targetPgid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    await this.killByName("SIGKILL");

    // Final safety net: kill wineserver so it can't respawn Quark.
    await this.wineserverK();

    this.proc = null;
    this.pgid = null;
    this.startedAt = null;
    this.lastLaunchAt = null;
    this.counts.stop++;
    this.setState("stopped");
    return this.status();
  }

  async restart(): Promise<ServerStatus> {
    await this.stop();
    return this.start();
  }

  // ── window state ───────────────────────────────────────────────────────────

  async minimize(): Promise<ServerStatus> {
    if (this.state === "running_minimized") return this.status();
    if (!(await this.isProcAlive())) {
      throw new Error("Quark is not running");
    }
    const wids = await this.findQuarkWindows();
    if (wids.length === 0) {
      throw new Error(
        `Quark window not found (title '${QUARK_WINDOW_TITLE}' missing). ` +
          "Refusing to fall back to a broad Wine-class match that would also " +
          "minimize IME / tray / dialog windows.",
      );
    }
    for (const wid of wids) {
      await run(["xdotool", "windowunmap", wid]).catch((e) =>
        log.warn(`windowunmap ${wid} failed: ${e}`)
      );
    }
    this.counts.minimize++;
    this.setState("running_minimized");
    return this.status();
  }

  async restore(): Promise<ServerStatus> {
    if (this.state === "running_visible") return this.status();
    if (!(await this.isProcAlive())) {
      throw new Error("Quark is not running");
    }
    const wids = await this.findQuarkWindows();
    if (wids.length === 0) {
      throw new Error(
        `Quark window not found (title '${QUARK_WINDOW_TITLE}' missing)`,
      );
    }
    for (const wid of wids) {
      await run(["xdotool", "windowmap", wid]).catch((e) =>
        log.warn(`windowmap ${wid} failed: ${e}`)
      );
    }
    this.setState("running_visible");
    return this.status();
  }

  async status(): Promise<ServerStatus> {
    // `alive` is the externally useful readiness signal, not merely the
    // launcher PID. The launcher may remain alive (or may have exited early)
    // while Chromium/CDP is unavailable.
    const alive = await this.chromiumListening();
    // Self-heal stale state in both directions against the authoritative
    // liveness signal (but don't rewrite internal state from a mere /status
    // call — leave the write to the lifecycle methods / idle client).
    let reported: ProcessState = this.state;
    if (alive && this.state === "stopped") reported = "running_visible";
    else if (
      alive && this.state === "starting"
    ) {
      // The launcher can exit before Chromium is ready. Promote the explicit
      // startup phase once CDP is accepting connections so callers can safely
      // distinguish a booting instance from a usable one.
      this.setState("running_visible");
      reported = "running_visible";
    } else if (
      !alive && this.lastLaunchAt !== null &&
      Date.now() - this.lastLaunchAt < START_GRACE_MS
    ) {
      reported = "starting";
    } else if (!alive && this.state !== "stopped") reported = "stopped";

    return {
      state: reported,
      pid: this.proc?.pid ?? null,
      alive,
      startedAt: this.startedAt,
      cdpActivityAt: this.lastCdpActivity,
      counts: { ...this.counts },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private buildLaunchCommand(): {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  } {
    const isRoot = (process.getuid?.() ?? -1) === 0;
    const env: Record<string, string | undefined> = { ...process.env };
    if (isRoot) {
      return {
        command: "su",
        args: ["-s", "/bin/bash", WINE_USER, "-c", `exec ${LAUNCH_SCRIPT}`],
        env,
      };
    }
    return { command: LAUNCH_SCRIPT, args: [], env };
  }

  private resolvePgid(): number | null {
    if (!this.proc) return null;
    const pgid = readProcessGroup(this.proc.pid);
    return isOwnProcessGroup(pgid, readProcessGroup(process.pid))
      ? pgid
      : null;
  }

  private async findQuarkWindows(): Promise<string[]> {
    const r = await run(["xdotool", "search", "--name", QUARK_WINDOW_TITLE]);
    if (!r.ok) {
      log.warn(`xdotool search failed: ${r.stderr}`);
      return [];
    }
    return r.stdout.split(/\s+/).filter(Boolean);
  }

  private async listMatchingPids(): Promise<number[]> {
    const pids: number[] = [];
    const myPid = process.pid;
    for (const dirEntry of await readdir("/proc")) {
      if (!/^\d+$/.test(dirEntry)) continue;
      const pid = Number(dirEntry);
      if (pid === myPid || pid === 1) continue;
      try {
        const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim()
          .toLowerCase();
        if (!this.patterns.some((p) => name.includes(p))) continue;
        let cmdline = "";
        try {
          cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
        } catch {
          // unreadable — skip
        }
        if (!NAME_ONLY.has(name) && !cmdline.toLowerCase().includes("quark")) {
          continue;
        }
        pids.push(pid);
      } catch {
        // process may have exited between readdir and read
      }
    }
    return pids;
  }

  private async quarkProcessesAlive(): Promise<boolean> {
    return (await this.listMatchingPids()).length > 0;
  }

  private async killByName(sig: "SIGTERM" | "SIGKILL"): Promise<void> {
    for (const pid of await this.listMatchingPids()) {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }

  private async wineserverK(): Promise<void> {
    if ((process.getuid?.() ?? -1) === 0) {
      await run([
        "su",
        "-s",
        "/bin/bash",
        WINE_USER,
        "-c",
        `${WINESERVER_BIN} -k`,
      ]).catch(
        () => {},
      );
    } else {
      await run([WINESERVER_BIN, "-k"]).catch(() => {});
    }
  }
}

// ── tiny process helpers ─────────────────────────────────────────────────────

/**
 * Process group of `pid` from /proc/<pid>/stat, or null when it cannot be read.
 * The pgrp is field 5, but `comm` is only parenthesised — it may itself contain
 * spaces and parentheses — so anchor the parse on the last ")".
 */
export function readProcessGroup(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * True when `pgid` is a group the launcher created for itself and is therefore
 * safe to signal with `kill(-pgid)`.
 *
 * Everything the container entrypoint starts — the X server, x11vnc, the CDP
 * proxy, this manager — shares PID 1's group, and a spawned launcher inherits
 * it. Signalling that group means `kill(0)` / `kill(-1)`: it reaches every
 * process in the container, so Xvfb and x11vnc die with it and Quark can never
 * start again until the pod is recreated.
 */
export function isOwnProcessGroup(
  pgid: number | null,
  ownPgid: number | null,
): pgid is number {
  if (pgid === null || !Number.isInteger(pgid) || pgid <= 1) return false;
  return ownPgid === null || pgid !== ownPgid;
}

async function run(
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    return {
      ok: code === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
