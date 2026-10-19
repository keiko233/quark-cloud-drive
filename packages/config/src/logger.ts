import { Logger } from "@jsr/libs__logger";
import { LOG_LEVEL } from "./env.ts";

/** Shared logger; every package logs through this singleton. */
export const log = new Logger({
  level: LOG_LEVEL,
  time: true,
  delta: true,
  caller: true,
});
