// ProcessManager — the thin process abstraction for apps/server.
//
// Owns ONLY process lifecycle + window state. All idle/sleep policy lives in
// apps/client; this module deliberately has no CPU sampling, no idle timer,
// no two-stage minimize/stop decisions, and no "re-adoption" heuristics beyond
// what's needed to stay authoritative about liveness.
//
// Liveness is TCP-probe of the CDP port — the only signal that survives the
// spark runtime where the `wine start.exe /Unix LNK` launcher exits early
// while Chromium keeps serving.

import { EventPublisher } from "@orpc/server";
import type { ProcessState, ServerStatus } from "@quark/contract/schemas";
import {
  LAUNCH_SCRIPT,
  QUARK_CDP_PORT,
  QUARK_WINDOW_TITLE,
  WINE_USER,
  WINESERVER_BIN,
} from "./env.ts";
import { log } from "./logger.ts";

const QUARK_HOST = "127.0.0.1";

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
  private proc: Deno.ChildProcess | null = null;
  private pgid: number | null = null;
  private startedAt: number | null = null;
  private lastCdpActivity: number | null = null;
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
    try {
      const conn = await Deno.connect({
        hostname: QUARK_HOST,
        port: QUARK_CDP_PORT,
      });
      conn.close();
      return true;
    } catch {
      return false;
    }
  }

  private async isProcAlive(): Promise<boolean> {
    if (this.proc && (await this.proc.status).code === null) return true;
    return this.chromiumListening();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<ServerStatus> {
    if (await this.isProcAlive()) {
      // If Chromium is serving but we think we're minimized, restore the
      // window (idempotent). Otherwise no-op.
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

    log.info("starting Quark via launch script");
    const cmd = this.buildLaunchCommand();
    try {
      this.proc = new Deno.Command(cmd.command, {
        args: cmd.args,
        env: cmd.env,
        stdout: "null",
        stderr: "null",
      }).spawn();
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
    this.counts.start++;
    this.setState("running_visible");
    log.info(`Quark started (pid=${this.proc.pid} pgid=${this.pgid})`);
    return this.status();
  }

  async stop(): Promise<ServerStatus> {
    log.info("stopping Quark");
    const targetPgid = this.pgid ?? (this.proc ? this.resolvePgid() : null);

    // Stage 1: process-group kill (standard runtime).
    if (targetPgid !== null) {
      try {
        Deno.kill(-targetPgid, "SIGTERM");
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
        Deno.kill(-targetPgid, "SIGKILL");
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
    const alive = await this.isProcAlive();
    // Self-heal stale state in both directions against the authoritative
    // liveness signal (but don't rewrite internal state from a mere /status
    // call — leave the write to the lifecycle methods / idle client).
    let reported: ProcessState = this.state;
    if (alive && this.state === "stopped") reported = "running_visible";
    else if (!alive && this.state !== "stopped") reported = "stopped";

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
    env: Record<string, string>;
  } {
    const isRoot = (Deno.uid() ?? -1) === 0;
    const env = { ...Deno.env.toObject() };
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
    try {
      const stat = Deno.readLinkSync(`/proc/${this.proc.pid}`);
      return Number(stat);
    } catch {
      // fall back to reading /proc/<pid>/stat's pgrp (field 5)
      try {
        const stat = Deno.readTextFileSync(`/proc/${this.proc.pid}/stat`);
        // field 4 is ppid, field 5 is pgrp (process group id)
        const parts = stat.split(" ");
        return Number(parts[4]);
      } catch {
        return null;
      }
    }
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
    const myPid = Deno.pid;
    for await (const dirEntry of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(dirEntry.name)) continue;
      const pid = Number(dirEntry.name);
      if (pid === myPid || pid === 1) continue;
      try {
        const name = (await Deno.readTextFile(`/proc/${pid}/comm`)).trim()
          .toLowerCase();
        if (!this.patterns.some((p) => name.includes(p))) continue;
        let cmdline = "";
        try {
          cmdline = await Deno.readTextFile(`/proc/${pid}/cmdline`);
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
        Deno.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }

  private async wineserverK(): Promise<void> {
    if ((Deno.uid() ?? -1) === 0) {
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

async function run(
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const p = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const { code, stdout, stderr } = await p.output();
    return {
      ok: code === 0,
      stdout: new TextDecoder().decode(stdout).trim(),
      stderr: new TextDecoder().decode(stderr).trim(),
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
