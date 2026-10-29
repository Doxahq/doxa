import {
  createHttpsRedirect,
  parseHttpsRedirectMode,
  type HttpsPolicyEnv,
} from "./https-policy";
import { stripInboundDoxaHeaders } from "./inbound-headers";
import { withDocsStrictTransportSecurity } from "./security-headers";

/**
 * The outer steps of every public dispatcher request, in this order:
 *
 * 1. Remove visitor-sent `x-doxa-*` headers, before any routing (F29).
 * 2. With `DOXA_PROD_HTTPS_REDIRECT_MODE=on`, redirect plain HTTP (M23).
 * 3. Route the request (`handle`).
 * 4. With the same mode, add HSTS to the HTTPS response.
 *
 * `handle` receives only the stripped request.
 */
export async function runEdgeGateway(
  request: Request,
  env: HttpsPolicyEnv,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const trusted = stripInboundDoxaHeaders(request);
  const mode = parseHttpsRedirectMode(env.DOXA_PROD_HTTPS_REDIRECT_MODE);
  if (mode === "off") return handle(trusted);
  const redirect = createHttpsRedirect(trusted);
  if (redirect) return redirect;
  return withDocsStrictTransportSecurity(await handle(trusted), trusted);
}
