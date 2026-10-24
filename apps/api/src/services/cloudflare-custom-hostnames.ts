import type { DocsDomainSslValidationRecord, DocsDomainVerificationStatus } from "@doxahq/contracts";
import type { DocsDomainProvisioningState } from "../repositories/docs-domains";

export class CloudflareCustomHostnameError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface CloudflareCustomHostnamesConfig {
  apiToken: string;
  zoneId: string;
  sslMethod?: string;
  minTlsVersion?: string;
  requestTimeoutMs?: number;
}

const DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS = 10_000;

export class CloudflareCustomHostnamesClient {
  private readonly apiToken: string;
  private readonly zoneId: string;
  private readonly sslMethod: string;
  private readonly minTlsVersion: string;
  private readonly requestTimeoutMs: number;

  constructor(config: CloudflareCustomHostnamesConfig) {
    this.apiToken = config.apiToken;
    this.zoneId = config.zoneId;
    this.sslMethod = config.sslMethod ?? "http";
    this.minTlsVersion = config.minTlsVersion ?? "1.2";
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_CLOUDFLARE_REQUEST_TIMEOUT_MS;
  }

  async create(hostname: string): Promise<DocsDomainProvisioningState> {
    const result = await this.requestCloudflareResult("POST", "/custom_hostnames", {
      hostname,
      ssl: this.createSslConfiguration(),
    });

    return toProvisioningState(result);
  }

  async get(customHostnameId: string): Promise<DocsDomainProvisioningState> {
    const result = await this.requestCloudflareResult("GET", `/custom_hostnames/${customHostnameId}`);
    return toProvisioningState(result);
  }

  async delete(customHostnameId: string): Promise<void> {
    try {
      await this.requestCloudflareResult("DELETE", `/custom_hostnames/${customHostnameId}`);
    } catch (err) {
      if (err instanceof CloudflareCustomHostnameError && err.status === 404) return;
      throw err;
    }
  }

  private async requestCloudflareResult(
    method: "GET" | "POST" | "DELETE",
    pathname: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;

    try {
      response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.zoneId}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new CloudflareCustomHostnameError(
        isAbortError(error)
          ? "Cloudflare custom hostname provisioning timed out."
          : "Cloudflare custom hostname provisioning could not reach Cloudflare.",
        isAbortError(error) ? 504 : 502,
      );
    } finally {
      clearTimeout(timeout);
    }

    const payload = await readCloudflarePayload(response);
    if (!payload.success) {
      throw new CloudflareCustomHostnameError(getCloudflareErrorMessage(payload), response.status);
    }

    if (!isRecord(payload.result)) {
      throw new CloudflareCustomHostnameError("Cloudflare returned an invalid custom hostname response.", response.status);
    }

    return payload.result;
  }

  private createSslConfiguration(): Record<string, unknown> {
    return {
      method: this.sslMethod,
      type: "dv",
      settings: {
        min_tls_version: this.minTlsVersion,
      },
      wildcard: false,
    };
  }
}

export function createCloudflareCustomHostnamesClient(config: {
  apiToken?: string;
  zoneId?: string;
  sslMethod?: string;
  minTlsVersion?: string;
}): CloudflareCustomHostnamesClient | null {
  if (!config.apiToken && !config.zoneId) return null;
  if (!config.apiToken || !config.zoneId) {
    throw new CloudflareCustomHostnameError(
      "Cloudflare custom hostname provisioning requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.",
      503,
    );
  }

  return new CloudflareCustomHostnamesClient({
    apiToken: config.apiToken,
    zoneId: config.zoneId,
    sslMethod: config.sslMethod,
    minTlsVersion: config.minTlsVersion,
  });
}

interface CloudflarePayload {
  success: boolean;
  result: unknown;
  errors: CloudflareApiError[];
}

interface CloudflareApiError {
  code: string | number | null;
  message: string;
}

async function readCloudflarePayload(response: Response): Promise<CloudflarePayload> {
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    return {
      success: false,
      result: null,
      errors: [{ code: response.status, message: "Cloudflare returned a non-JSON response." }],
    };
  }

  return {
    success: payload.success === true,
    result: payload.result,
    errors: readCloudflareErrors(payload.errors),
  };
}

function readCloudflareErrors(value: unknown): CloudflareApiError[] {
  if (!Array.isArray(value)) return [];

  return value.map((error) => {
    if (!isRecord(error)) {
      return { code: null, message: "Unknown Cloudflare API error." };
    }

    return {
      code: readStringOrNumber(error.code),
      message: readString(error.message) ?? "Unknown Cloudflare API error.",
    };
  });
}

function getCloudflareErrorMessage(payload: CloudflarePayload): string {
  const message = payload.errors.at(0)?.message;
  return message ? `Cloudflare custom hostname provisioning failed: ${message}` : "Cloudflare custom hostname provisioning failed.";
}

function toProvisioningState(result: Record<string, unknown>): DocsDomainProvisioningState {
  const providerHostnameId = readString(result.id);
  if (!providerHostnameId) {
    throw new CloudflareCustomHostnameError("Cloudflare custom hostname response did not include an id.");
  }

  const ssl = readRecord(result.ssl);
  const providerStatus = readString(result.status);
  const providerSslStatus = ssl ? readString(ssl.status) : null;
  const validationErrors = ssl ? readValidationErrors(ssl.validation_errors) : [];
  const verificationError = validationErrors.at(0) ?? null;

  return {
    provider: "cloudflare",
    providerHostnameId,
    providerStatus,
    providerSslStatus,
    verificationStatus: toVerificationStatus({
      providerStatus,
      providerSslStatus,
      verificationError,
    }),
    ownershipVerification: readOwnershipVerification(result.ownership_verification),
    ownershipVerificationHttp: readOwnershipVerificationHttp(result.ownership_verification_http),
    sslValidationRecords: ssl ? readSslValidationRecords(ssl.validation_records) : [],
    verificationError,
  };
}

function toVerificationStatus(input: {
  providerStatus: string | null;
  providerSslStatus: string | null;
  verificationError: string | null;
}): DocsDomainVerificationStatus {
  if (input.verificationError || isFailureStatus(input.providerStatus) || isFailureStatus(input.providerSslStatus)) {
    return "failed";
  }

  if (input.providerStatus === "active" && input.providerSslStatus === "active") {
    return "verified";
  }

  return "pending";
}

function isFailureStatus(status: string | null): boolean {
  return status === "blocked" || status === "deleted" || status === "failed" || status === "validation_timed_out";
}

function readOwnershipVerification(value: unknown): DocsDomainProvisioningState["ownershipVerification"] {
  const record = readRecord(value);
  if (!record) return null;

  return {
    type: readString(record.type),
    name: readString(record.name),
    value: readString(record.value),
  };
}

function readOwnershipVerificationHttp(value: unknown): DocsDomainProvisioningState["ownershipVerificationHttp"] {
  const record = readRecord(value);
  if (!record) return null;

  return {
    url: readString(record.http_url),
    body: readString(record.http_body),
  };
}

function readSslValidationRecords(value: unknown): DocsDomainSslValidationRecord[] {
  if (!Array.isArray(value)) return [];

  return value.map((record) => {
    const validationRecord = readRecord(record);
    return {
      status: validationRecord ? readString(validationRecord.status) : null,
      txtName: validationRecord ? readString(validationRecord.txt_name) : null,
      txtValue: validationRecord ? readString(validationRecord.txt_value) : null,
      httpUrl: validationRecord ? readString(validationRecord.http_url) : null,
      httpBody: validationRecord ? readString(validationRecord.http_body) : null,
    };
  });
}

function readValidationErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((error) => {
    const record = readRecord(error);
    const message = record ? readString(record.message) : null;
    return message ? [message] : [];
  });
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringOrNumber(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}
