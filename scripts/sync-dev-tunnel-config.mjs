import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(rootDir, "infra/cloudflared/dev.env");
const generatedFile = resolve(rootDir, ".cloudflared/dev-remote-config.json");

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  const source = readFileSync(path, "utf8");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (process.env[key] !== undefined && !value) {
      continue;
    }

    process.env[key] = value;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name} in infra/cloudflared/dev.env`);
  }
  return value;
}

function createIngressConfig() {
  const hostname = process.env.DOXA_DEV_HOSTNAME?.trim() || "dev.doxa.so";
  const apiOrigin = process.env.DOXA_API_ORIGIN?.trim() || "http://localhost:8787";
  const webOrigin = process.env.DOXA_WEB_ORIGIN?.trim() || "http://localhost:3001";

  return {
    config: {
      ingress: [
        { hostname, path: "^/api/auth.*$", service: apiOrigin },
        // The login page links here to start a sign-in before it hydrates.
        { hostname, path: "^/sign-in/.*$", service: apiOrigin },
        { hostname, path: "^/me$", service: apiOrigin },
        { hostname, path: "^/github.*$", service: apiOrigin },
        { hostname, path: "^/projects.*$", service: apiOrigin },
        { hostname, path: "^/jobs.*$", service: apiOrigin },
        { hostname, path: "^/internal.*$", service: apiOrigin },
        { hostname, path: "^/health.*$", service: apiOrigin },
        // Not all of /oauth: the web app serves the /oauth/consent page.
        { hostname, path: "^/oauth/(authorize|token|register)$", service: apiOrigin },
        { hostname, path: "^/\\.well-known/oauth-authorization-server$", service: apiOrigin },
        { hostname, path: "^/agent-access.*$", service: apiOrigin },
        // The web app owns /approve/<id>; only the API lookup lives here.
        { hostname, path: "^/approval-requests.*$", service: apiOrigin },
        { hostname, path: "^/approval-settings.*$", service: apiOrigin },
        // The web app owns /dashboard/teams and /invite/<token>.
        { hostname, path: "^/teams.*$", service: apiOrigin },
        { hostname, path: "^/team-invites.*$", service: apiOrigin },
        { hostname, path: "^/email-preferences.*$", service: apiOrigin },
        // The web app owns /dashboard/billing; the API serves /billing
        // (offers, accounts, Checkout, Portal and the Stripe webhook).
        { hostname, path: "^/billing.*$", service: apiOrigin },
        // Not /email: the web app serves the /email/unsubscribe page, and the
        // API's POST /email/unsubscribe shares that path, which a tunnel route
        // cannot split by method. The one-click unsubscribe from the page does
        // not reach the API through this tunnel.
        { hostname, service: webOrigin },
        { service: "http_status:404" },
      ],
    },
  };
}

loadEnvFile(envFile);

const accountId = requireEnv("CLOUDFLARED_ACCOUNT_ID");
const tunnelId = requireEnv("CLOUDFLARED_TUNNEL_ID");
const apiToken = requireEnv("CLOUDFLARED_API_TOKEN");
const payload = createIngressConfig();

const verifyResponse = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
  headers: {
    "authorization": `Bearer ${apiToken}`,
  },
});
const verifyBody = await verifyResponse.json().catch(() => undefined);

if (!verifyResponse.ok || verifyBody?.success === false) {
  console.error("Cloudflare API token verification failed.");
  console.error("Make sure CLOUDFLARED_API_TOKEN is a Cloudflare API token, not the tunnel run token.");
  console.error(JSON.stringify(verifyBody, null, 2));
  process.exit(1);
}

mkdirSync(dirname(generatedFile), { recursive: true });
writeFileSync(generatedFile, `${JSON.stringify(payload, null, 2)}\n`);

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`;
const response = await fetch(endpoint, {
  method: "PUT",
  headers: {
    "authorization": `Bearer ${apiToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const body = await response.json().catch(() => undefined);

if (!response.ok || body?.success === false) {
  console.error(`Failed to sync Cloudflare Tunnel config (${response.status}).`);
  console.error("Check that CLOUDFLARED_ACCOUNT_ID owns this tunnel and that CLOUDFLARED_API_TOKEN can edit Cloudflare Tunnel config.");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`Synced Cloudflare Tunnel config for ${process.env.DOXA_DEV_HOSTNAME || "dev.doxa.so"}.`);
console.log(`Generated payload: ${generatedFile}`);
