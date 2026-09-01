import { Logger } from "@libs/logger";
import { LOG_LEVEL } from "./env.ts";

export const log = new Logger({
  level: LOG_LEVEL,
  time: true,
  delta: true,
  caller: true,
});
