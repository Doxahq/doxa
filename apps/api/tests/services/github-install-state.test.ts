import { describe, expect, test } from "vitest";
import {
  InstallStateSigner,
  createInstallNonce,
  isInstallNonce,
  sameNonce,
  type InstallState,
} from "../../src/services/github-install-state";

const NOW = 1_800_000_000;

function state(overrides: Partial<InstallState> = {}): InstallState {
  return {
    userId: "user-1",
    installationId: "12345",
    nonce: createInstallNonce(),
    expiresAt: NOW + 600,
    ...overrides,
  };
}

describe("InstallStateSigner", () => {
  test("verifies a state that it signed", async () => {
    const signer = new InstallStateSigner("secret");
    const value = state();

    await expect(signer.verify(await signer.sign(value), NOW)).resolves.toEqual(value);
  });

  test("rejects a state signed with another secret", async () => {
    const signed = await new InstallStateSigner("other-secret").sign(state());

    await expect(new InstallStateSigner("secret").verify(signed, NOW)).resolves.toBeNull();
  });

  test("rejects a payload that was changed after signing", async () => {
    const signer = new InstallStateSigner("secret");
    const [, signature] = (await signer.sign(state())).split(".");
    const forged = btoa(
      JSON.stringify({ u: "attacker", i: "12345", n: createInstallNonce(), e: NOW + 600 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expect(signer.verify(`${forged}.${signature}`, NOW)).resolves.toBeNull();
  });

  test("rejects an expired state", async () => {
    const signer = new InstallStateSigner("secret");
    const signed = await signer.sign(state({ expiresAt: NOW }));

    await expect(signer.verify(signed, NOW)).resolves.toBeNull();
  });

  test.each(["", "abc", "a.b.c", "!!!.???", "e30.e30"])(
    "rejects the malformed state %j",
    async (value) => {
      await expect(new InstallStateSigner("secret").verify(value, NOW)).resolves.toBeNull();
    },
  );
});

describe("install nonce", () => {
  test("creates 43-character base64url nonces that differ", () => {
    const first = createInstallNonce();
    const second = createInstallNonce();

    expect(isInstallNonce(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  test("compares nonces", () => {
    const nonce = createInstallNonce();

    expect(sameNonce(nonce, nonce)).toBe(true);
    expect(sameNonce(nonce, createInstallNonce())).toBe(false);
    expect(sameNonce(nonce, nonce.slice(1))).toBe(false);
  });

  test("rejects values that are not nonces", () => {
    expect(isInstallNonce(undefined)).toBe(false);
    expect(isInstallNonce("short")).toBe(false);
    expect(isInstallNonce(`${"a".repeat(42)}=`)).toBe(false);
  });
});
