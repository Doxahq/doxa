import {
  RemoteCallError,
  decodeArguments,
  decodeResult,
  encodeResult,
  encodeValue,
  toRemoteErrorInfo,
} from "./codec";
import { CODEC_CONTENT_TYPE } from "./protocol";
import { secretsMatch } from "./shared-secret";

export type FetchLike = (request: Request) => Promise<Response>;

export interface RemoteCallTarget {
  /** Sends the request: global fetch, or a service binding's fetch. */
  readonly fetch: FetchLike;
  /** Absolute URL of the call, for example http://doxa-api-origin/__rpc/InternalApi/addJobEvent. */
  readonly url: string;
  readonly keyHeader: string;
  readonly key: string;
  /** Extra headers, for example the client IP. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Makes one call on the other side and returns its value. A thrown remote
 * error is thrown here again, with its name and message. A transport or
 * protocol failure throws an error that names the call.
 */
export async function callRemote(target: RemoteCallTarget, args: readonly unknown[]): Promise<unknown> {
  const response = await target.fetch(
    new Request(target.url, {
      method: "POST",
      headers: {
        ...target.headers,
        "content-type": CODEC_CONTENT_TYPE,
        [target.keyHeader]: target.key,
      },
      body: encodeValue(args),
      // fetch keeps custom headers on a redirect, so a followed redirect would
      // send the key to whatever host the Location names. "manual" returns the
      // 3xx, which fails the call below. Workers do not support "error".
      redirect: "manual",
    }),
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Remote call ${new URL(target.url).pathname} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = decodeResult(body);
  if (result.ok) return result.value;
  throw new RemoteCallError(result.error);
}

export interface ServeRemoteCallOptions {
  readonly keyHeader: string;
  readonly key: string;
}

/**
 * Serves one call made with `callRemote`: checks the key, decodes the
 * arguments, runs `invoke` and encodes its value or its error. A wrong key
 * gets 401 and a bad body 400. An error thrown by `invoke` is a normal
 * result, so the caller sees it as a thrown error.
 */
export async function serveRemoteCall(
  request: Request,
  options: ServeRemoteCallOptions,
  invoke: (args: unknown[]) => unknown,
): Promise<Response> {
  if (request.method !== "POST") return plainResponse("Method not allowed.", 405);
  if (!secretsMatch(request.headers.get(options.keyHeader), options.key)) {
    return plainResponse("Unauthorized.", 401);
  }

  let args: unknown[];
  try {
    args = decodeArguments(await request.text());
  } catch (cause) {
    return plainResponse(`Bad call body: ${toRemoteErrorInfo(cause).message}`, 400);
  }

  let body: string;
  try {
    body = encodeResult({ ok: true, value: await invoke(args) });
  } catch (cause) {
    body = encodeResult({ ok: false, error: toRemoteErrorInfo(cause) });
  }
  return new Response(body, { headers: { "content-type": CODEC_CONTENT_TYPE } });
}

function plainResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
