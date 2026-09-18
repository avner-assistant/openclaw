import { sleepWithAbort } from "../../infra/backoff.js";

export type MainSessionRecoveryCapacity = {
  acquire: (shouldContinue: () => boolean) => Promise<(() => void) | undefined>;
};

export function createMainSessionRecoveryCapacity(options: {
  limit: number;
  waitMs: number;
}): MainSessionRecoveryCapacity {
  let active = 0;
  return {
    async acquire(shouldContinue) {
      const deadline = Date.now() + options.waitMs;
      while (active >= options.limit && shouldContinue()) {
        if (Date.now() >= deadline) {
          return undefined;
        }
        await sleepWithAbort(Math.min(50, Math.max(1, deadline - Date.now())), undefined, {
          ref: false,
        });
      }
      if (!shouldContinue()) {
        return undefined;
      }
      active += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        active -= 1;
      };
    },
  };
}
