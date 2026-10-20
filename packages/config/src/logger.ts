import { inspect } from "node:util";
import { LOG_LEVEL, type LogLevel } from "./env.ts";

type Level = Exclude<LogLevel, "silent">;

const PRIORITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: Infinity,
};

const COLOR = Boolean(process.stderr.isTTY || process.stdout.isTTY) &&
  !process.env["NO_COLOR"];
const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  trace: "\x1b[90m",
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

let lastLogAt = performance.now();

function callerLocation(): string {
  const lines = new Error().stack?.split("\n") ?? [];
  const frame = lines.find((line) =>
    line.includes(" at ") && !line.includes("/config/src/logger.ts:")
  );
  return frame?.trim().replace(/^at\s+/, "") ?? "";
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return inspect(value, { colors: COLOR, depth: 6, breakLength: Infinity });
}

function emit(level: Level, content: unknown[]): void {
  if (PRIORITY[level] < PRIORITY[LOG_LEVEL]) return;

  const now = performance.now();
  const delta = (now - lastLogAt) / 1000;
  lastLogAt = now;

  const timestamp = new Date();
  const clock = `${timestamp.toTimeString().slice(0, 8)}.${
    String(timestamp.getMilliseconds()).padStart(3, "0")
  }`;
  const label = level.toUpperCase().padStart(5);
  const prefix = COLOR
    ? `${ANSI[level]}${label}${ANSI.reset} ${ANSI.dim}│ +${
      delta.toFixed(3)
    } ¦ ${clock} ${callerLocation()}${ANSI.reset}`
    : `${label} │ +${delta.toFixed(3)} ¦ ${clock} ${callerLocation()}`;
  const output = `${prefix}    ${content.map(formatValue).join(" ")}`;

  if (level === "warn" || level === "error") console.error(output);
  else console.log(output);
}

/** Shared logger; every package logs through this singleton. */
export const log = {
  trace: (...content: unknown[]) => emit("trace", content),
  debug: (...content: unknown[]) => emit("debug", content),
  info: (...content: unknown[]) => emit("info", content),
  warn: (...content: unknown[]) => emit("warn", content),
  error: (...content: unknown[]) => emit("error", content),
};
