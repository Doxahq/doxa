import type { Env } from "../env";

type GitHubWebhookVerificationEnv = Pick<
  Env,
  | "GITHUB_WEBHOOK_SECRET"
  | "DOXA_RUNTIME_ENVIRONMENT"
  | "ALLOW_INSECURE_GITHUB_WEBHOOKS"
>;

export async function verifyGitHubWebhook(
  request: Request,
  env: GitHubWebhookVerificationEnv,
  body: string,
): Promise<boolean> {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return isDevelopmentBypassEnabled(env);

  const signature = request.headers.get("x-hub-signature-256");
  const receivedDigest = parseSha256Signature(signature);
  if (!receivedDigest) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    receivedDigest,
    encoder.encode(body),
  );
}

function isDevelopmentBypassEnabled(env: GitHubWebhookVerificationEnv): boolean {
  return env.DOXA_RUNTIME_ENVIRONMENT === "development"
    && parseBooleanFlag(env.ALLOW_INSECURE_GITHUB_WEBHOOKS);
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseSha256Signature(
  signature: string | null,
): Uint8Array<ArrayBuffer> | null {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "");
  if (!match) return null;

  const hexDigest = match[1];
  const bytes = new Uint8Array(new ArrayBuffer(hexDigest.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexDigest.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
