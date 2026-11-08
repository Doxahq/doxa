import {
  AGENT_ASSET_UPLOAD_LIMITS,
  DOCS_ASSET_LIMITS,
} from "@doxahq/contracts/docs-assets";
import type { AgentAssetUploadResource } from "@doxahq/contracts/storage-gc";
import { sha256Hex } from "@doxahq/docs-engine";
import { z } from "zod";
import type { Env } from "../../../env";
import { DocsVersionGcEntriesRepository } from "../../../repositories/docs-version-gc-entries";
import {
  agentAssetUploadFileKey,
  agentAssetUploadTicketKey,
  agentUploadOwnerKeys,
  type AgentConnection,
} from "./agent-asset-upload-keys";
import { OpenUploadLedger } from "./agent-upload-ledger";
import { createR2AgentUploadStore, type AgentUploadStore } from "./agent-upload-store";
import { checkDocsAsset } from "./asset-content";

/**
 * Upload URLs for MCP agents. An agent cannot send a large file inside a
 * tool call: the model would have to write every base64 character. Instead
 * `create_asset_upload` stores a ticket and returns a URL and a secret. The
 * agent sends the bytes to the URL with one PUT, and `finish_asset_upload`
 * hands them to `DocsBranchAssetUpload`, which checks the image again as it
 * checks every other upload.
 *
 * - The secret travels in the Authorization header, never in the URL, so
 *   request logs do not record it. The ticket keeps only its SHA-256.
 * - The PUT stores only a file that passes the docs image check.
 * - One file per URL: the PUT that moves the ticket from `open` to
 *   `received` with a compare-and-swap wins; any other PUT writes nothing.
 * - A URL closes after `maxFailedAttempts` refused PUTs.
 * - The body must arrive within `bodyTimeoutSeconds`, and the expiry is
 *   checked again after the read, so no file lands after the URL expired.
 * - A member holds at most `maxOpenPerMember` open URLs, and each of their
 *   connections at most `maxOpenPerConnection`. The member's ledger counts
 *   them with a compare-and-swap, so concurrent requests cannot pass it.
 * - The `agent_asset_upload` collector deletes what an agent never finished.
 *
 * Keys: see `agent-asset-upload-keys.ts`.
 */

const SECRET_BYTES = 32;
/** base64url of 32 bytes, without padding. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const ticketSchema = z
  .object({
    version: z.literal(1),
    uploadId: z.uuid(),
    secretSha256: z.string().regex(SHA256_PATTERN),
    ownerUserId: z.string().min(1),
    projectId: z.uuid(),
    branchId: z.uuid(),
    /** The member and OAuth client behind the connection that created it. */
    agent: z.object({ userId: z.string().min(1), clientId: z.string().min(1) }).strict(),
    memberKey: z.string().regex(SHA256_PATTERN),
    connectionKey: z.string().regex(SHA256_PATTERN),
    fileName: z.string().min(1).max(200),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    state: z.enum(["open", "received"]),
    failedAttempts: z.number().int().nonnegative(),
  })
  .strict();

export type AgentAssetUploadRecord = z.infer<typeof ticketSchema>;

export interface CreateAgentAssetUploadInput {
  ownerUserId: string;
  projectId: string;
  branchId: string;
  agent: AgentConnection;
  fileName: string;
}

export interface CreatedAgentAssetUpload {
  uploadId: string;
  /** Goes into the Authorization header only. Never stored, never logged. */
  secret: string;
  expiresAt: string;
}

/** What the upload URL read from the request body. */
export type BodyReadOutcome =
  | { kind: "body"; bytes: Uint8Array }
  | { kind: "too_large" }
  | { kind: "timed_out" };

/**
 * Reads the request body up to `maxBytes`, within the body deadline. It
 * stops reading as soon as the body is too large or too slow.
 */
export type BoundedBodyReader = (maxBytes: number) => Promise<BodyReadOutcome>;

/** A refused PUT that counts toward closing the URL. */
type AgentAssetBodyFailure = "too_large" | "timed_out" | "empty" | "not_an_image";

/** Why the upload URL refused a PUT. Each maps to one HTTP status. */
export type AgentAssetReceiveFailure =
  | AgentAssetBodyFailure
  | "not_found"
  | "expired"
  | "already_received"
  | "closed"
  | "conflict";

export type AgentAssetReceiveResult =
  | { ok: true; size: number }
  | { ok: false; reason: AgentAssetReceiveFailure };

/** Who may finish an upload: the connection that created it, on its project. */
export interface AgentUploadOwner {
  projectId: string;
  agent: AgentConnection;
}

export type AgentAssetTakeResult =
  | { kind: "ready"; ticket: AgentAssetUploadRecord; bytes: Uint8Array }
  | { kind: "not_found" }
  | { kind: "not_sent"; ticket: AgentAssetUploadRecord };

export interface AgentAssetUploadsDeps {
  store: AgentUploadStore;
  /** Records the upload for garbage collection before any key is written. */
  registerUpload(resource: AgentAssetUploadResource): Promise<unknown>;
  now?: () => Date;
  createId?: () => string;
  randomBytes?: (length: number) => Uint8Array;
}

interface VersionedTicket {
  ticket: AgentAssetUploadRecord;
  etag: string;
}

export class AgentAssetUploads {
  private readonly ledger: OpenUploadLedger;

  constructor(private readonly deps: AgentAssetUploadsDeps) {
    this.ledger = new OpenUploadLedger(deps.store);
  }

  /** For the MCP Worker: the R2 binding supports the conditional writes. */
  static fromEnv(env: Env): AgentAssetUploads {
    const gcEntries = new DocsVersionGcEntriesRepository(env);
    return new AgentAssetUploads({
      store: createR2AgentUploadStore(env.DOCS_BUCKET),
      registerUpload: (resource) => gcEntries.enqueueAgentAssetUpload(resource),
    });
  }

  /**
   * For the upload URL handler: it only receives files, so it needs the
   * bucket and no database connection.
   */
  static receiverFor(bucket: R2Bucket): AgentAssetUploads {
    return new AgentAssetUploads({
      store: createR2AgentUploadStore(bucket),
      registerUpload: () =>
        Promise.reject(new Error("A receiver cannot create upload URLs.")),
    });
  }

  /**
   * Opens an upload URL. Throws `asset_upload_limit_reached` when the
   * connection or the member holds the most open URLs it can.
   */
  async create(input: CreateAgentAssetUploadInput): Promise<CreatedAgentAssetUpload> {
    const owner = await agentUploadOwnerKeys(input.agent);
    const now = this.now();
    const uploadId = (this.deps.createId ?? (() => crypto.randomUUID()))();
    const expiresAtMs = now.getTime() + AGENT_ASSET_UPLOAD_LIMITS.ttlSeconds * 1000;
    // The slot comes first. If a later step fails, the slot stays taken
    // until it expires, so a failure never frees a slot early.
    await this.ledger.claim(
      owner,
      { uploadId, connectionKey: owner.connectionKey, expiresAtMs },
      now,
    );

    const secret = base64Url(this.randomBytes(SECRET_BYTES));
    const ticket: AgentAssetUploadRecord = {
      version: 1,
      uploadId,
      secretSha256: await sha256Text(secret),
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      branchId: input.branchId,
      agent: { userId: input.agent.userId, clientId: input.agent.clientId },
      memberKey: owner.memberKey,
      connectionKey: owner.connectionKey,
      fileName: input.fileName,
      createdAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      state: "open",
      failedAttempts: 0,
    };

    await this.deps.registerUpload({ uploadId });
    await this.deps.store.write(
      agentAssetUploadTicketKey(uploadId),
      JSON.stringify(ticket),
      "application/json; charset=utf-8",
    );
    return { uploadId, secret, expiresAt: ticket.expiresAt };
  }

  /**
   * Receives the file of an upload URL. A bad URL or secret never reads the
   * body. The staged bytes are the bytes as sent; `finish_asset_upload`
   * checks them again and stores the cleaned file.
   */
  async receive(
    uploadId: string,
    secret: string,
    readBody: BoundedBodyReader,
  ): Promise<AgentAssetReceiveResult> {
    const current = await this.authenticate(uploadId, secret);
    if (!current) return { ok: false, reason: "not_found" };
    const refusal = this.refusalBeforeBody(current.ticket);
    if (refusal) return { ok: false, reason: refusal };

    const outcome = await readBody(DOCS_ASSET_LIMITS.maxBytes);
    // The body can take until the deadline: never store after the expiry.
    if (this.isExpired(current.ticket)) return { ok: false, reason: "expired" };
    const body = acceptBody(outcome);
    if (!body.ok) {
      await this.recordFailure(current);
      return { ok: false, reason: body.reason };
    }

    const received: AgentAssetUploadRecord = { ...current.ticket, state: "received" };
    if (!(await this.replaceTicket(current, received))) {
      return { ok: false, reason: "conflict" };
    }
    await this.deps.store.write(
      agentAssetUploadFileKey(uploadId),
      body.bytes,
      "application/octet-stream",
    );
    return { ok: true, size: body.bytes.byteLength };
  }

  /**
   * The ticket and the staged bytes of an upload, for its owner only, while
   * it has not expired. Another connection or project gets "not_found",
   * before any byte is read.
   */
  async takeFor(uploadId: string, owner: AgentUploadOwner): Promise<AgentAssetTakeResult> {
    if (!z.uuid().safeParse(uploadId).success) return { kind: "not_found" };
    const current = await this.readTicket(uploadId);
    if (!current || !isOwnedBy(current.ticket, owner) || this.isExpired(current.ticket)) {
      return { kind: "not_found" };
    }
    const { ticket } = current;
    if (ticket.state !== "received") return { kind: "not_sent", ticket };
    // The file is written right after the state change; until then it is not sent.
    const bytes = await this.deps.store.readBytes(agentAssetUploadFileKey(uploadId));
    return bytes ? { kind: "ready", ticket, bytes } : { kind: "not_sent", ticket };
  }

  /**
   * Deletes both keys of the upload, then frees its slot. The collector
   * entry finds nothing later.
   */
  async discard(ticket: AgentAssetUploadRecord): Promise<void> {
    await this.deps.store.removeMany([
      agentAssetUploadTicketKey(ticket.uploadId),
      agentAssetUploadFileKey(ticket.uploadId),
    ]);
    await this.ledger.release(ticket.memberKey, ticket.uploadId, this.now());
  }

  private refusalBeforeBody(
    ticket: AgentAssetUploadRecord,
  ): AgentAssetReceiveFailure | null {
    if (this.isExpired(ticket)) return "expired";
    if (ticket.state === "received") return "already_received";
    if (ticket.failedAttempts >= AGENT_ASSET_UPLOAD_LIMITS.maxFailedAttempts) return "closed";
    return null;
  }

  /** Best effort: a lost race means another request changed the ticket. */
  private async recordFailure(current: VersionedTicket): Promise<void> {
    await this.replaceTicket(current, {
      ...current.ticket,
      failedAttempts: current.ticket.failedAttempts + 1,
    });
  }

  private replaceTicket(
    current: VersionedTicket,
    next: AgentAssetUploadRecord,
  ): Promise<boolean> {
    return this.deps.store.replaceIfUnchanged(
      agentAssetUploadTicketKey(next.uploadId),
      JSON.stringify(next),
      current.etag,
    );
  }

  /** The ticket when the ID and the secret match one, else null. */
  private async authenticate(uploadId: string, secret: string): Promise<VersionedTicket | null> {
    if (!z.uuid().safeParse(uploadId).success || !SECRET_PATTERN.test(secret)) {
      return null;
    }
    const current = await this.readTicket(uploadId);
    if (!current) return null;
    const presented = await sha256Text(secret);
    return constantTimeEqual(presented, current.ticket.secretSha256) ? current : null;
  }

  private async readTicket(uploadId: string): Promise<VersionedTicket | null> {
    const stored = await this.deps.store.readVersioned(agentAssetUploadTicketKey(uploadId));
    if (!stored) return null;
    try {
      const parsed = ticketSchema.safeParse(JSON.parse(stored.text));
      return parsed.success && parsed.data.uploadId === uploadId
        ? { ticket: parsed.data, etag: stored.etag }
        : null;
    } catch {
      return null;
    }
  }

  private isExpired(ticket: AgentAssetUploadRecord): boolean {
    return Date.parse(ticket.expiresAt) <= this.now().getTime();
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private randomBytes(length: number): Uint8Array {
    if (this.deps.randomBytes) return this.deps.randomBytes(length);
    return crypto.getRandomValues(new Uint8Array(length));
  }
}

/** The body bytes when they are a docs image, else why the PUT is refused. */
function acceptBody(
  outcome: BodyReadOutcome,
): { ok: true; bytes: Uint8Array } | { ok: false; reason: AgentAssetBodyFailure } {
  if (outcome.kind !== "body") return { ok: false, reason: outcome.kind };
  if (outcome.bytes.byteLength === 0) return { ok: false, reason: "empty" };
  const checked = checkDocsAsset(outcome.bytes);
  if (checked.ok) return { ok: true, bytes: outcome.bytes };
  return { ok: false, reason: checked.reason === "too_large" ? "too_large" : "not_an_image" };
}

function isOwnedBy(ticket: AgentAssetUploadRecord, owner: AgentUploadOwner): boolean {
  return (
    ticket.projectId === owner.projectId &&
    ticket.agent.userId === owner.agent.userId &&
    ticket.agent.clientId === owner.agent.clientId
  );
}

function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Both inputs are hex digests of the same length. */
function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
