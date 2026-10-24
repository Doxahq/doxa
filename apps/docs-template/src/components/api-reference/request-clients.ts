import type { EndpointCodeSample } from "@/src/lib/endpoint-document";

const REQUEST_CLIENT_STORAGE_KEY = "doxa:request-client";

const REQUEST_CLIENT_NAMES: ReadonlyMap<string, string> = new Map([
  ["curl", "curl"],
  ["node-fetch", "Node (Fetch)"],
  ["node-xhr", "Node (XMLHttpRequest)"],
  ["python-requests", "Python (Requests)"],
  ["python-httpx", "Python (Httpx)"],
  ["go", "Go"],
]);

export function requestClientName(client: string): string {
  return REQUEST_CLIENT_NAMES.get(client) ?? client;
}

export function selectRequestSample(
  samples: readonly EndpointCodeSample[],
  selectedClient: string | null
): EndpointCodeSample | undefined {
  return (
    samples.find((sample) => sample.client === selectedClient) ?? samples[0]
  );
}

export function loadStoredRequestClient(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(REQUEST_CLIENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredRequestClient(client: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REQUEST_CLIENT_STORAGE_KEY, client);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
