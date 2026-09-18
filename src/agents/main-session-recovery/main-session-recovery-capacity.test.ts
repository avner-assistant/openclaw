import { expect, it } from "vitest";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";

it("bounds restored recovery until the active run settles", async () => {
  const capacity = createMainSessionRecoveryCapacity({ limit: 1, waitMs: 20 });
  const release = await capacity.acquire(() => true);
  expect(release).toBeTypeOf("function");
  await expect(capacity.acquire(() => true)).resolves.toBeUndefined();
  release?.();
  const nextRelease = await capacity.acquire(() => true);
  expect(nextRelease).toBeTypeOf("function");
  nextRelease?.();
});
