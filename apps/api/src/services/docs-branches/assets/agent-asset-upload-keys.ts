import { sha256Hex } from "@doxahq/docs-engine";
import { z } from "zod";

/**
 * Storage keys of MCP upload URLs. Both roots live outside every site
 * prefix, so no docs route can serve them.
 *
 * - `agent-uploads/{uploadId}/ticket.json` and `.../file`: one upload.
 * - `agent-upload-ledgers/{memberKey}.json`: the open uploads of one member.
 *   Every change to it is a compare-and-swap, so the open-upload limits hold
 *   under concurrent requests. See `agent-upload-ledger.ts`.
 *
 * Member and connection keys are SHA-256 hex digests: the IDs never appear
 * in a key, and no character inside an ID can change the shape of a key.
 */

const UPLOAD_ROOT = "agent-uploads/";
const LEDGER_ROOT = "agent-upload-ledgers/";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** The member and the OAuth client behind one MCP connection. */
export interface AgentConnection {
  userId: string;
  clientId: string;
}

export interface AgentUploadOwnerKeys {
  memberKey: string;
  connectionKey: string;
}

function sha256Json(parts: readonly string[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(parts)));
}

/** JSON keeps the parts apart, so no separator inside an ID can collide. */
export async function agentUploadOwnerKeys(
  connection: AgentConnection,
): Promise<AgentUploadOwnerKeys> {
  const [memberKey, connectionKey] = await Promise.all([
    sha256Json(["member", connection.userId]),
    sha256Json(["connection", connection.userId, connection.clientId]),
  ]);
  return { memberKey, connectionKey };
}

export function agentAssetUploadPrefix(uploadId: string): string {
  return `${UPLOAD_ROOT}${z.uuid().parse(uploadId)}/`;
}

export function agentAssetUploadTicketKey(uploadId: string): string {
  return `${agentAssetUploadPrefix(uploadId)}ticket.json`;
}

export function agentAssetUploadFileKey(uploadId: string): string {
  return `${agentAssetUploadPrefix(uploadId)}file`;
}

function requireDigest(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error("An owner key must be a SHA-256 hex digest.");
  }
  return value;
}

export function openUploadLedgerKey(memberKey: string): string {
  return `${LEDGER_ROOT}${requireDigest(memberKey)}.json`;
}
