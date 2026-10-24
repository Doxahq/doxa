import { cloudflare } from "@cloudflare/vite-plugin";
import type { WorkerConfig } from "@cloudflare/vite-plugin";
import { nitro } from "nitro/vite";
import type { PluginOption } from "vite";

export type DeploymentTarget = "cloudflare" | "vercel" | "docker";

type RuntimeEnv = Record<string, string | undefined>;

type LocalPlatformWorkerConfig = Pick<WorkerConfig, "vars" | "secrets">;

export function getDeploymentTarget(): DeploymentTarget {
  switch (process.env.DOXA_DEPLOY_TARGET) {
    case "docker":
      return "docker";
    case "vercel":
      return "vercel";
    default:
      return "cloudflare";
  }
}

export function getHostingPlugins(target: DeploymentTarget): PluginOption[] {
  if (target === "vercel") {
    return [nitro({ preset: "vercel" })];
  }

  if (target === "docker") {
    return [nitro({ preset: "node-server" })];
  }

  const localPlatformConfig = getLocalPlatformWorkerConfig();

  return [
    cloudflare({
      ...(process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
        ? { configPath: process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH }
        : {}),
      viteEnvironment: { name: "ssr" },
      ...(localPlatformConfig
        ? {
            config: (config: WorkerConfig) => ({
              vars: {
                ...config.vars,
                ...localPlatformConfig.vars,
              },
              secrets: localPlatformConfig.secrets,
            }),
          }
        : {}),
    }),
  ];
}

export function getLocalPlatformWorkerConfig(
  env: RuntimeEnv = process.env
): LocalPlatformWorkerConfig | undefined {
  if (env.DOXA_DOCS_LOCAL_PLATFORM_DEV !== "1") return undefined;

  const contentWorkerUrl = normalizeHttpOrigin(
    env.DOXA_DOCS_CONTENT_WORKER_URL
  );
  if (!contentWorkerUrl) {
    throw new Error(
      "DOXA_DOCS_CONTENT_WORKER_URL must be a valid HTTP(S) origin in local platform mode."
    );
  }
  if (!env.DOXA_DOCS_CONTENT_TOKEN?.trim()) {
    throw new Error(
      "DOXA_DOCS_CONTENT_TOKEN is required in local platform mode."
    );
  }

  return {
    vars: {
      DOXA_DOCS_RUNTIME_SOURCE: "platform",
      DOXA_DOCS_CONTENT_WORKER_URL: contentWorkerUrl,
      DOXA_DOCS_CONTENT_RUNTIME_PATH: "/runtime-source",
      ...readAccessGateVars(env),
    },
    secrets: {
      required: ["DOXA_DOCS_CONTENT_TOKEN"],
    },
  };
}

/**
 * Vite rejects a request whose Host header it does not recognize. A tunnel
 * is not used for docs, but non-localhost deployment hosts still need an
 * explicit allowlist. The leading dot is Vite's "this host and its subdomains"
 * form.
 *
 * A localhost base domain needs no entry, because Vite always allows localhost.
 */
export function getDevAllowedHosts(env: RuntimeEnv = process.env): string[] {
  const docsBaseDomain = env.DOXA_DOCS_BASE_DOMAIN?.trim();
  if (!docsBaseDomain || docsBaseDomain === "localhost") return [];

  return [docsBaseDomain, `.${docsBaseDomain}`];
}

const ACCESS_GATE_VAR_NAMES = [
  "DOXA_API_BASE_URL",
  "DOXA_DASHBOARD_BASE_URL",
  "DOXA_DOCS_BASE_DOMAIN",
] as const;

function readAccessGateVars(env: RuntimeEnv): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const name of ACCESS_GATE_VAR_NAMES) {
    const value = env[name]?.trim();
    if (value) vars[name] = value;
  }

  return vars;
}

function normalizeHttpOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;

  try {
    const url = new URL(value);
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    if (!isHttp || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
