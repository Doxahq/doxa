import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import { ANTHROPIC_AUDIENCE } from "../../../services/model-access/model-token-broker";

/** The longest JWT that STS signs. With a 3600-second rule, it gives a 60-minute Anthropic token. */
const IDENTITY_TOKEN_SECONDS = 3600;

/**
 * Signs a JWT for the origin's task role with AWS STS. The SDK reads the
 * task role credentials over `node:http`, so the strict public fetch guard,
 * which blocks the link-local credentials address, does not apply.
 *
 * `GetWebIdentityToken` exists only on regional STS endpoints.
 */
export function stsIdentityTokenProvider(region: string): () => Promise<string> {
  const sts = new STSClient({ region });
  return async () => {
    const output = await sts.send(new GetWebIdentityTokenCommand({
      Audience: [ANTHROPIC_AUDIENCE],
      SigningAlgorithm: "RS256",
      DurationSeconds: IDENTITY_TOKEN_SECONDS,
    }));
    if (!output.WebIdentityToken) throw new Error("AWS STS returned no web identity token.");
    return output.WebIdentityToken;
  };
}
