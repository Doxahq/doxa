export interface DoxaAgentBuildInfo {
  packageName: "@doxahq/agent";
  version: string;
  entryFormat: "esm";
}

export const doxaAgentVersion = "0.1.1";

export const buildInfo: DoxaAgentBuildInfo = Object.freeze({
  packageName: "@doxahq/agent",
  version: doxaAgentVersion,
  entryFormat: "esm",
});
