import type { NormalizedPluginsConfig } from "../../../plugins/config-state.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../../plugins/public-surface-loader.js";

type GitHubDoctorContract = {
  collectGitHubUpgradeWarnings: (policy: NormalizedPluginsConfig) => string[];
};

/** Optional bundled diagnostics must not prevent Doctor from repairing minimal installs. */
export function collectGitHubUpgradeWarnings(policy: NormalizedPluginsConfig): string[] {
  const artifact = loadBundledPluginPublicArtifactModuleFromCandidatesSync<GitHubDoctorContract>({
    dirName: "github",
    artifactCandidates: ["doctor-contract-api.js"],
  });
  return artifact?.collectGitHubUpgradeWarnings(policy) ?? [];
}
