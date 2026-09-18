// Daemon constant tests cover platform constants used by service installers.
import { describe, expect, it } from "vitest";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayLaunchAgentLabel,
  resolveGatewayNativeServiceIdentityConflict,
  resolveGatewayProfileSuffix,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "./constants.js";

describe("resolveGatewayLaunchAgentLabel", () => {
  it("returns default label when no profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel();
    expect(result).toBe(GATEWAY_LAUNCH_AGENT_LABEL);
    expect(result).toBe("ai.openclaw.gateway");
  });

  it("returns profile-specific label when profile is set", () => {
    const result = resolveGatewayLaunchAgentLabel("dev");
    expect(result).toBe("ai.openclaw.dev");
  });
});

describe("resolveGatewaySystemdServiceName", () => {
  it("returns default service name when no profile is set", () => {
    const result = resolveGatewaySystemdServiceName();
    expect(result).toBe("openclaw-gateway");
  });

  it("returns profile-specific service name when profile is set", () => {
    const result = resolveGatewaySystemdServiceName("dev");
    expect(result).toBe("openclaw-gateway-dev");
  });
});

describe("resolveGatewayWindowsTaskName", () => {
  it("returns default task name when no profile is set", () => {
    const result = resolveGatewayWindowsTaskName();
    expect(result).toBe("OpenClaw Gateway");
  });

  it("returns profile-specific task name when profile is set", () => {
    const result = resolveGatewayWindowsTaskName("dev");
    expect(result).toBe("OpenClaw Gateway (dev)");
  });
});

describe("resolveGatewayNativeServiceIdentityConflict", () => {
  it.each([
    {
      platform: "darwin" as const,
      envKey: "OPENCLAW_LAUNCHD_LABEL",
      value: "ai.openclaw.gateway",
    },
    {
      platform: "linux" as const,
      envKey: "OPENCLAW_SYSTEMD_UNIT",
      value: "openclaw-gateway.service",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "OpenClaw Gateway",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "\\Nested\\OpenClaw Gateway (work)",
    },
    {
      platform: "win32" as const,
      envKey: "OPENCLAW_WINDOWS_TASK_NAME",
      value: "\\OpenClaw Gateway (other)",
    },
  ])("rejects $envKey overrides for named profiles on $platform", ({ platform, envKey, value }) => {
    expect(
      resolveGatewayNativeServiceIdentityConflict(
        { OPENCLAW_PROFILE: "work", [envKey]: value },
        platform,
      ),
    ).toMatchObject({ envKey });
  });

  it.each([
    {
      name: "canonical named-profile systemd identity",
      platform: "linux",
      env: { OPENCLAW_PROFILE: "work", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-work" },
    },
    {
      name: "default-profile systemd override",
      platform: "linux",
      env: { OPENCLAW_SYSTEMD_UNIT: "custom-gateway.service" },
    },
    ...["OpenClaw Gateway (work)", "\\OpenClaw Gateway (work)", "\\OPENCLAW GATEWAY (WORK)"].map(
      (taskName) => ({
        name: `native Windows identity ${taskName}`,
        platform: "win32" as const,
        env: { OPENCLAW_PROFILE: "work", OPENCLAW_WINDOWS_TASK_NAME: taskName },
      }),
    ),
    {
      name: "default-profile nested Windows override",
      platform: "win32",
      env: { OPENCLAW_WINDOWS_TASK_NAME: "\\Nested\\Custom Gateway" },
    },
  ] as const)("accepts $name", ({ env, platform }) => {
    expect(resolveGatewayNativeServiceIdentityConflict(env, platform)).toBeNull();
  });
});

describe("resolveGatewayProfileSuffix", () => {
  it("returns empty string when no profile is set", () => {
    expect(resolveGatewayProfileSuffix()).toBe("");
  });

  it("returns empty string for default profiles", () => {
    expect(resolveGatewayProfileSuffix("default")).toBe("");
    expect(resolveGatewayProfileSuffix(" Default ")).toBe("");
  });

  it("returns a hyphenated suffix for custom profiles", () => {
    expect(resolveGatewayProfileSuffix("dev")).toBe("-dev");
  });

  it("trims whitespace from profiles", () => {
    expect(resolveGatewayProfileSuffix("  staging  ")).toBe("-staging");
  });
});

describe("resolveGatewayServiceDescription", () => {
  it("returns default description when no profile", () => {
    expect(resolveGatewayServiceDescription({ env: {} })).toBe("OpenClaw Gateway");
  });

  it("includes profile when set", () => {
    expect(resolveGatewayServiceDescription({ env: { OPENCLAW_PROFILE: "work" } })).toBe(
      "OpenClaw Gateway (profile: work)",
    );
  });

  it("ignores legacy install-time version metadata", () => {
    expect(
      resolveGatewayServiceDescription({ env: { OPENCLAW_SERVICE_VERSION: "2026.1.10" } }),
    ).toBe("OpenClaw Gateway");
  });

  it("prefers explicit description override", () => {
    expect(
      resolveGatewayServiceDescription({
        env: { OPENCLAW_PROFILE: "work" },
        description: "Custom",
      }),
    ).toBe("Custom");
  });
});

describe("LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES", () => {
  it("includes known pre-rebrand gateway unit names", () => {
    expect(LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES).toContain("clawdbot-gateway");
  });
});
