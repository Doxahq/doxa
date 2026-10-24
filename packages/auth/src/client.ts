import { createAuthClient } from "better-auth/react";

const baseURL =
  typeof import.meta !== "undefined"
    ? ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL ?? "")
    : "";

export const authClient = createAuthClient({
  baseURL,
});

export type AuthClient = typeof authClient;
