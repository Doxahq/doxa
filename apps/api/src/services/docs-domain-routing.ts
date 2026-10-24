import type { DocsDomainRoutingStatus } from "@doxahq/contracts";

// The probe runs inside the create/refresh request, after the Cloudflare API call.
// Keep the budget short so the API response stays well below the dashboard timeout.
const DEFAULT_ROUTING_CHECK_TIMEOUT_MS = 5_000;

// Keep this protocol in sync with apps/docs-template/src/lib/renderer-health.ts.
// The renderer does not import platform packages, so this small protocol is duplicated.
const RENDERER_HEALTH_PATH = "/.well-known/doxa-health";
const RENDERER_HEALTH_HEADER = "x-doxa-renderer-health";
const RENDERER_HEALTH_VALUE = "ok";

export interface DocsDomainRoutingState {
  status: DocsDomainRoutingStatus;
  httpStatus: number | null;
  error: string | null;
  checkedAt: Date | null;
}

export interface DocsDomainRoutingProbe {
  check(hostname: string): Promise<DocsDomainRoutingState>;
}

export interface DocsDomainRoutingRequestError {
  hostname: string;
  errorName: string;
  errorMessage: string;
}

interface HttpDocsDomainRoutingProbeOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  onRequestError?: (error: DocsDomainRoutingRequestError) => void;
}

export class HttpDocsDomainRoutingProbe implements DocsDomainRoutingProbe {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly onRequestError: (
    error: DocsDomainRoutingRequestError,
  ) => void;

  constructor(options: HttpDocsDomainRoutingProbeOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ROUTING_CHECK_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.onRequestError = options.onRequestError ?? logRoutingRequestError;
  }

  async check(hostname: string): Promise<DocsDomainRoutingState> {
    const checkedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(
        `https://${hostname}${RENDERER_HEALTH_PATH}`,
        {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
        },
      );

      if (isHealthyRendererResponse(response)) {
        return {
          status: "healthy",
          httpStatus: response.status,
          error: null,
          checkedAt,
        };
      }

      return {
        status: "failed",
        httpStatus: response.status,
        error: getRoutingError(response),
        checkedAt,
      };
    } catch (error) {
      if (!isAbortError(error)) {
        this.onRequestError(toRoutingRequestError(hostname, error));
      }

      return {
        status: "failed",
        httpStatus: null,
        error: isAbortError(error)
          ? "The routing check timed out before the documentation renderer responded."
          : "The routing check could not reach the documentation renderer.",
        checkedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createDocsDomainRoutingProbe(): DocsDomainRoutingProbe {
  return new HttpDocsDomainRoutingProbe();
}

export function createPendingDocsDomainRoutingState(): DocsDomainRoutingState {
  return {
    status: "pending",
    httpStatus: null,
    error: null,
    checkedAt: null,
  };
}

function getRoutingError(response: Response): string {
  if (response.status === 522) {
    return "Cloudflare reached the custom hostname, but the documentation origin returned HTTP 522.";
  }

  if (response.status >= 500) {
    return `The documentation renderer returned HTTP ${response.status}.`;
  }

  return "The hostname responded without the Doxa documentation renderer health response.";
}

function isHealthyRendererResponse(response: Response): boolean {
  return (
    response.status === 204 &&
    response.headers.get(RENDERER_HEALTH_HEADER) === RENDERER_HEALTH_VALUE
  );
}

function toRoutingRequestError(
  hostname: string,
  error: unknown,
): DocsDomainRoutingRequestError {
  return {
    hostname,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage:
      error instanceof Error
        ? error.message
        : "An unknown request error occurred.",
  };
}

function logRoutingRequestError(error: DocsDomainRoutingRequestError): void {
  console.warn("Docs domain routing request failed.", error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
