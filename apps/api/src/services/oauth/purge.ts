import type { PurgeOptions, PurgeResult } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../../env";
import { authorizationServerFor } from "./authorization-server";
import { requireOAuthConfig } from "./oauth-config";

export const PURGE_CURSOR_KEY = "oauth-purge-cursor";

const PURGE_BATCH_SIZE = 50;

export interface PurgeCursorStore {
  read(): Promise<string | null>;
  write(cursor: string): Promise<void>;
  clear(): Promise<void>;
}

export interface OAuthDataPurgeDependencies {
  purge: (options: PurgeOptions) => Promise<PurgeResult>;
  cursors: PurgeCursorStore;
  batchSize: number;
}

/**
 * Cron cleanup of expired and orphaned grants and tokens. The cursor is saved
 * so each run continues the sweep instead of re-checking the first batch.
 */
export class OAuthDataPurge {
  constructor(private readonly deps: OAuthDataPurgeDependencies) {}

  static fromEnv(env: Env): OAuthDataPurge {
    const { config, env: oauthEnv } = requireOAuthConfig(env);
    const server = authorizationServerFor(config);
    return new OAuthDataPurge({
      purge: (options) => server.purgeExpiredData(oauthEnv, options),
      cursors: new KvPurgeCursorStore(oauthEnv.OAUTH_KV),
      batchSize: PURGE_BATCH_SIZE,
    });
  }

  async run(): Promise<PurgeResult> {
    const cursor = await this.deps.cursors.read();
    const result = await this.purgeFrom(cursor);
    if (result.done || result.cursor === undefined) {
      await this.deps.cursors.clear();
    } else {
      await this.deps.cursors.write(result.cursor);
    }
    return result;
  }

  private async purgeFrom(cursor: string | null): Promise<PurgeResult> {
    try {
      return await this.deps.purge({
        batchSize: this.deps.batchSize,
        ...(cursor === null ? {} : { cursor }),
      });
    } catch (cause) {
      // A stale cursor must not fail every later run; the next run starts over.
      if (cursor !== null) await this.deps.cursors.clear();
      throw cause;
    }
  }
}

export class KvPurgeCursorStore implements PurgeCursorStore {
  constructor(private readonly kv: KVNamespace) {}

  read(): Promise<string | null> {
    return this.kv.get(PURGE_CURSOR_KEY, "text");
  }

  async write(cursor: string): Promise<void> {
    await this.kv.put(PURGE_CURSOR_KEY, cursor);
  }

  async clear(): Promise<void> {
    await this.kv.delete(PURGE_CURSOR_KEY);
  }
}
