import { Result } from "better-result";
import { z } from "zod";
import { log } from "../../libs/logger.ts";
import { enqueueBrowserOperation } from "../browser.ts";
import type { TtlCache } from "../cache.ts";

type ActionCacheOptions<Args extends unknown[], Value, Key> = {
  cache: TtlCache<Key, Value>;
  key: (...args: Args) => Key;
  keyLabel?: (key: Key, args: Args) => string;
};

export type ActionMetadata = {
  label: string;
  description: string;
  mcp: {
    name: string;
    input: z.ZodType;
  };
};

export type Action<Args extends unknown[], Value> =
  & ((...args: Args) => Promise<Result<Value, Error>>)
  & { metadata: ActionMetadata };

export function createAction<Args extends unknown[], Value, Key = never>(
  label: string,
  impl: (...args: Args) => Promise<Value>,
  options: {
    description: string;
    mcp: {
      name: string;
      input?: z.ZodType;
    };
    cache?: ActionCacheOptions<Args, Value, Key>;
  },
): Action<Args, Value> {
  const action = ((...args: Args) => {
    const cache = options?.cache;
    let cacheKey: Key;
    let hasCacheKey = false;

    if (cache) {
      cacheKey = cache.key(...args);
      hasCacheKey = true;
      const keyLabel = cache.keyLabel?.(cacheKey, args) ?? "";
      const cached = cache.cache.get(cacheKey);
      if (cached !== undefined) {
        log.debug(`${label}: cache hit${keyLabel}`);
        return Promise.resolve(Result.ok(cached));
      }
      log.debug(`${label}: cache miss${keyLabel}, enqueueing`);
    }

    return enqueueBrowserOperation(() => impl(...args), label)
      .then((value) => {
        if (cache && hasCacheKey) {
          cache.cache.set(cacheKey, value);
        }
        return Result.ok(value);
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e));
        log.warn(`${label} failed: ${error.message}`);
        return Result.err(error);
      });
  }) as Action<Args, Value>;

  action.metadata = {
    label,
    description: options.description,
    mcp: {
      name: options.mcp.name,
      input: options.mcp.input ?? z.object({}),
    },
  };

  return action;
}

/**
 * Unwraps a `Result<T, E>` to either its value or throws the contained error.
 * Mirrors the `unwrap` helper used on the server side (`server/router.ts:36`).
 * Intended for *internal* use from one action that needs to call another
 * action's underlying value without leaking the `Result` envelope to its own
 * caller.
 */
// deno-lint-ignore no-explicit-any
export function unwrapResult<T>(result: any): T {
  // deno-lint-ignore no-explicit-any
  return (result as { match: (...args: any[]) => any }).match({
    ok: (v: T) => v,
    err: (e: Error): never => {
      throw e;
    },
  }) as T;
}
