import { AGENT_ASSET_UPLOAD_LIMITS } from "@doxahq/contracts/docs-assets";
import { z } from "zod";
import { DocsContentError } from "../../docs-content/errors";
import { openUploadLedgerKey, type AgentUploadOwnerKeys } from "./agent-asset-upload-keys";
import type { AgentUploadStore } from "./agent-upload-store";

/**
 * The open upload URLs of one member, in one object. A claim reads the
 * ledger, drops the expired entries, checks both limits, and writes the
 * ledger back with a compare-and-swap. Of two claims that run at the same
 * moment, only one can write; the other reads again and counts the new
 * entry. So the limits hold exactly under concurrent requests.
 *
 * Nothing deletes a ledger: R2 has no conditional delete, so a delete could
 * erase a claim that landed just before it. A ledger is one small object per
 * member, and its entries expire on their own. The storage GC runner, which
 * has no compare-and-swap, never edits it.
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const entrySchema = z
  .object({
    uploadId: z.uuid(),
    connectionKey: z.string().regex(SHA256_PATTERN),
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

const ledgerSchema = z
  .object({ version: z.literal(1), open: z.array(entrySchema) })
  .strict();

export type OpenUploadEntry = z.infer<typeof entrySchema>;

/**
 * A swap fails only when another request wrote the ledger in between. At
 * most `maxOpenPerMember` claims can write before the ledger is full, and
 * after that a claim fails the count without a write. So this bound settles
 * any burst of claims; only releases at the same moment can add rounds.
 */
const MAX_SWAP_ATTEMPTS = AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerMember + 2;

const LIMIT_MESSAGES = {
  connection: `This connection already has ${AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerConnection} open upload URLs.`,
  member: `This member already has ${AGENT_ASSET_UPLOAD_LIMITS.maxOpenPerMember} open upload URLs across their connections.`,
} as const;

type LimitScope = keyof typeof LIMIT_MESSAGES;

/** The entries to store, or null to leave the ledger as it is. */
type LedgerChange = (open: readonly OpenUploadEntry[]) => OpenUploadEntry[] | null;

export class OpenUploadLedger {
  constructor(private readonly store: AgentUploadStore) {}

  /**
   * Records `entry` as open. Throws `asset_upload_limit_reached` when the
   * connection or the member holds the most open URLs it can, and
   * `asset_upload_busy` when other requests keep changing the ledger.
   */
  async claim(owner: AgentUploadOwnerKeys, entry: OpenUploadEntry, now: Date): Promise<void> {
    const written = await this.update(owner.memberKey, now, (open) => {
      assertRoom(open, owner.connectionKey, now);
      return [...open, entry];
    });
    if (!written) {
      throw new DocsContentError(
        "asset_upload_busy",
        "Other requests of this member changed the open upload URLs at the same moment.",
      );
    }
  }

  /**
   * Frees the slot of an upload. When other requests keep changing the
   * ledger, the entry stays until it expires: a slot never frees early.
   */
  async release(memberKey: string, uploadId: string, now: Date): Promise<void> {
    await this.update(memberKey, now, (open) =>
      open.some((entry) => entry.uploadId === uploadId)
        ? open.filter((entry) => entry.uploadId !== uploadId)
        : null,
    );
  }

  /** False when every swap lost to another write. */
  private async update(memberKey: string, now: Date, change: LedgerChange): Promise<boolean> {
    const key = openUploadLedgerKey(memberKey);
    for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
      const stored = await this.store.readVersioned(key);
      const open = parseOpenEntries(stored?.text).filter(
        (entry) => entry.expiresAtMs > now.getTime(),
      );
      const next = change(open);
      if (next === null) return true;
      const text = JSON.stringify({ version: 1, open: next });
      const written = stored
        ? await this.store.replaceIfUnchanged(key, text, stored.etag)
        : await this.store.createIfAbsent(key, text);
      if (written) return true;
    }
    return false;
  }
}

/**
 * Only this module writes a ledger. If one cannot be read anyway, it counts
 * as empty, and the next swap replaces it.
 */
function parseOpenEntries(text: string | undefined): OpenUploadEntry[] {
  if (text === undefined) return [];
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.open : [];
  } catch {
    return [];
  }
}

function assertRoom(open: readonly OpenUploadEntry[], connectionKey: string, now: Date): void {
  const ofConnection = open.filter((entry) => entry.connectionKey === connectionKey);
  const { maxOpenPerConnection, maxOpenPerMember } = AGENT_ASSET_UPLOAD_LIMITS;
  if (ofConnection.length >= maxOpenPerConnection) {
    throw limitReached("connection", ofConnection, maxOpenPerConnection, now);
  }
  if (open.length >= maxOpenPerMember) {
    throw limitReached("member", open, maxOpenPerMember, now);
  }
}

/** `retryAfterSeconds`: when enough of `open` expire to free one slot. */
function limitReached(
  scope: LimitScope,
  open: readonly OpenUploadEntry[],
  max: number,
  now: Date,
): DocsContentError {
  const expiries = open.map((entry) => entry.expiresAtMs).sort((left, right) => left - right);
  const freesAtMs = expiries[expiries.length - max] ?? now.getTime();
  return new DocsContentError("asset_upload_limit_reached", LIMIT_MESSAGES[scope], {
    scope,
    maxOpenUploads: max,
    retryAfterSeconds: Math.max(1, Math.ceil((freesAtMs - now.getTime()) / 1000)),
  });
}
