import { expect, it, vi } from "vitest";
import { createSessionsTool } from "./sessions-tool.js";

it("pages cloud profile summaries and returns the selected OS/machine catalog", async () => {
  const profiles = Array.from({ length: 33 }, (_, index) => ({
    id: "profile-" + index,
    providerId: "fixture",
    operatingSystems: [{ id: "linux", label: "Linux", default: true }],
    machines: [{ id: "tiny", label: "Tiny", os: "linux", cpu: 2 }],
  }));
  const callGateway = vi
    .fn()
    .mockResolvedValue({ environments: [{ id: "private-worker" }], profiles });
  const tool = createSessionsTool({ callGateway });
  const first = await tool.execute("catalog", { action: "cloud_profiles" });
  expect(first.details).toMatchObject({
    profiles: profiles.slice(0, 32).map(({ id, providerId }) => ({ id, providerId })),
    nextOffset: 32,
  });
  expect(first.details).not.toHaveProperty("environments");
  const last = await tool.execute("catalog-page", { action: "cloud_profiles", offset: 32 });
  expect(last.details).toEqual({ profiles: [{ id: "profile-32", providerId: "fixture" }] });
  const selected = await tool.execute("profile", {
    action: "cloud_profiles",
    profileId: "profile-32",
  });
  expect(selected.details).toEqual({ profile: profiles[32] });
  expect(callGateway).toHaveBeenCalledWith({ method: "environments.list", params: {} });
  const missing = await tool.execute("missing", {
    action: "cloud_profiles",
    profileId: "removed",
  });
  expect(missing.details).toMatchObject({ status: "error", profileId: "removed" });
});
