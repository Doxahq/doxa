import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareCustomHostnameError,
  CloudflareCustomHostnamesClient,
  createCloudflareCustomHostnamesClient,
} from "../../src/services/cloudflare-custom-hostnames";

describe("CloudflareCustomHostnamesClient", () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("creates custom hostnames with managed DV SSL settings", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      result: createCloudflareHostname({
        id: "hostname-1",
        status: "pending",
        sslStatus: "pending_validation",
      }),
      errors: [],
    }));

    const client = new CloudflareCustomHostnamesClient({
      apiToken: "token-1",
      zoneId: "zone-1",
    });
    const provisioning = await client.create("docs.example.com");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/zones/zone-1/custom_hostnames",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer token-1",
          "content-type": "application/json",
        }),
      }),
    );
    expect(readRequestBody(fetchMock)).toMatchObject({
      hostname: "docs.example.com",
      ssl: {
        method: "http",
        type: "dv",
        wildcard: false,
        settings: {
          min_tls_version: "1.2",
        },
      },
    });
    expect(provisioning).toMatchObject({
      provider: "cloudflare",
      providerHostnameId: "hostname-1",
      providerStatus: "pending",
      providerSslStatus: "pending_validation",
      verificationStatus: "pending",
      ownershipVerification: {
        type: "txt",
        name: "_cf-custom-hostname.docs.example.com",
        value: "ownership-token",
      },
      ownershipVerificationHttp: {
        url: "http://docs.example.com/.well-known/cf-custom-hostname-challenge/hostname-1",
        body: "ownership-token",
      },
      sslValidationRecords: [
        {
          status: "pending",
          txtName: "_acme-challenge.docs.example.com",
          txtValue: "ssl-token",
          httpUrl: null,
          httpBody: null,
        },
      ],
    });
  });

  test("marks active Cloudflare hostnames as verified", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      result: createCloudflareHostname({
        id: "hostname-1",
        status: "active",
        sslStatus: "active",
      }),
      errors: [],
    }));

    const client = new CloudflareCustomHostnamesClient({
      apiToken: "token-1",
      zoneId: "zone-1",
    });

    await expect(client.get("hostname-1")).resolves.toMatchObject({
      verificationStatus: "verified",
    });
  });

  test("throws stable errors for Cloudflare API failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      {
        success: false,
        result: null,
        errors: [{ code: 1000, message: "Authentication error" }],
      },
      { status: 403 },
    ));

    const client = new CloudflareCustomHostnamesClient({
      apiToken: "token-1",
      zoneId: "zone-1",
    });

    await expect(client.create("docs.example.com")).rejects.toMatchObject({
      message: "Cloudflare custom hostname provisioning failed: Authentication error",
      status: 403,
    });
  });

  test("stops Cloudflare requests that exceed their deadline", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }));
    const client = new CloudflareCustomHostnamesClient({
      apiToken: "token-1",
      zoneId: "zone-1",
      requestTimeoutMs: 1_000,
    });
    const result = expect(client.get("hostname-1")).rejects.toMatchObject({
      message: "Cloudflare custom hostname provisioning timed out.",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await result;
  });

  test("treats missing custom hostnames as already deleted", async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      {
        success: false,
        result: null,
        errors: [{ code: 1001, message: "Custom hostname not found" }],
      },
      { status: 404 },
    ));

    const client = new CloudflareCustomHostnamesClient({
      apiToken: "token-1",
      zoneId: "zone-1",
    });

    await expect(client.delete("hostname-1")).resolves.toBeUndefined();
  });
});

describe("createCloudflareCustomHostnamesClient", () => {
  test("returns null when custom hostname provisioning is not configured", () => {
    expect(createCloudflareCustomHostnamesClient({})).toBeNull();
  });

  test("rejects partial Cloudflare configuration", () => {
    expect(() => createCloudflareCustomHostnamesClient({ apiToken: "token-1" })).toThrow(
      CloudflareCustomHostnameError,
    );
  });
});

function createCloudflareHostname(input: {
  id: string;
  status: string;
  sslStatus: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    hostname: "docs.example.com",
    status: input.status,
    ownership_verification: {
      type: "txt",
      name: "_cf-custom-hostname.docs.example.com",
      value: "ownership-token",
    },
    ownership_verification_http: {
      http_url: "http://docs.example.com/.well-known/cf-custom-hostname-challenge/hostname-1",
      http_body: "ownership-token",
    },
    ssl: {
      method: "http",
      type: "dv",
      status: input.sslStatus,
      validation_records: [
        {
          status: "pending",
          txt_name: "_acme-challenge.docs.example.com",
          txt_value: "ssl-token",
        },
      ],
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function readRequestBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  return JSON.parse(typeof body === "string" ? body : "{}") as unknown;
}
