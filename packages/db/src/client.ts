import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export interface HyperdriveBinding {
  connectionString: string;
}

export interface DbEnv {
  HYPERDRIVE?: HyperdriveBinding;
  HYPERDRIVE_CACHE_DISABLED?: HyperdriveBinding;
  DATABASE_URL?: string;
}

export function createPgPool(env: DbEnv): Pool {
  return createPool(resolveFreshConnectionString(env));
}

export function createCachedPgPool(env: DbEnv): Pool {
  return createPool(resolveCachedConnectionString(env));
}

function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
  });
}

/**
 * Where `createDb`, `createCachedDb` and request scopes get their pools, and
 * where a request scope gives them back.
 *
 * The default opens a new pool each time and ends it with its scope. That
 * suits Workers: isolates are short-lived and Hyperdrive pools the
 * connections. A long-running Node server installs a shared provider with
 * `usePgPoolProvider`, so the process keeps one warm pool per connection.
 */
export interface PgPoolProvider {
  acquire(connectionString: string): Pool;
  release(pool: Pool): Promise<void>;
}

const newPoolPerUse: PgPoolProvider = {
  acquire: createPool,
  release: (pool) => pool.end(),
};

let poolProvider: PgPoolProvider = newPoolPerUse;

/** Installs the pool provider of this process and returns the previous one. */
export function usePgPoolProvider(provider: PgPoolProvider): PgPoolProvider {
  const previous = poolProvider;
  poolProvider = provider;
  return previous;
}

export interface SharedPgPoolOptions {
  /** Most open connections per connection string. */
  max: number;
  /** Close a connection after it was idle this long. */
  idleTimeoutMillis?: number;
  /** Fail a checkout that waits longer than this for a connection. */
  connectionTimeoutMillis?: number;
}

export interface SharedPgPoolProvider extends PgPoolProvider {
  /** Ends every pool. Call it once, at shutdown. */
  close(): Promise<void>;
}

/**
 * One pool per connection string for the life of the process. A request
 * scope borrows the pool and gives nothing back: the pool stays open for the
 * next request.
 */
export function createSharedPgPoolProvider(options: SharedPgPoolOptions): SharedPgPoolProvider {
  const pools = new Map<string, Pool>();

  return {
    acquire(connectionString) {
      let pool = pools.get(connectionString);
      if (!pool) {
        pool = new Pool({
          connectionString,
          max: options.max,
          idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
          connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
          keepAlive: true,
        });
        // An idle client that the server drops emits here. Without a listener
        // the error would end the process.
        pool.on("error", (cause) => {
          console.error("An idle Postgres connection failed.", cause);
        });
        pools.set(connectionString, pool);
      }
      return pool;
    },
    release: async () => {},
    async close() {
      const open = [...pools.values()];
      pools.clear();
      await Promise.all(open.map((pool) => pool.end()));
    },
  };
}

export function createDb(env: DbEnv): DoxaDb {
  const scope = requestScopes.get(env);
  if (scope) {
    return readScopedDb(scope, "fresh", () => resolveFreshConnectionString(env));
  }

  return createDrizzle(poolProvider.acquire(resolveFreshConnectionString(env)));
}

export function createCachedDb(env: DbEnv): DoxaDb {
  const scope = requestScopes.get(env);
  if (scope) {
    return readScopedDb(scope, "cached", () => resolveCachedConnectionString(env));
  }

  return createDrizzle(poolProvider.acquire(resolveCachedConnectionString(env)));
}

function createDrizzle(pool: Pool) {
  return drizzle(pool, { schema });
}

export type DoxaDb = ReturnType<typeof createDrizzle>;

export type PgPoolFactory = (connectionString: string) => Pool;

export interface RequestDbScope<E extends DbEnv> {
  env: E;
  close(): Promise<void>;
}

export interface RequestDbScopeOptions {
  /** Pools for this scope, ended with it. Without it, the process provider serves the scope. */
  createPool?: PgPoolFactory;
}

type ConnectionKind = "fresh" | "cached";

interface ScopedConnection {
  pool: Pool;
  db: DoxaDb;
}

interface RequestScopeState {
  pools: PgPoolProvider;
  connections: Map<ConnectionKind, ScopedConnection>;
  closing?: Promise<void>;
}

// Keyed by the scoped env object so repositories that call createDb(env)
// share one pool per request without changing their signatures.
const requestScopes = new WeakMap<DbEnv, RequestScopeState>();

export function createRequestDbScope<E extends DbEnv>(
  env: E,
  options: RequestDbScopeOptions = {},
): RequestDbScope<E> {
  const scopedEnv: E = { ...env };
  const state: RequestScopeState = {
    pools: options.createPool
      ? { acquire: options.createPool, release: (pool) => pool.end() }
      : poolProvider,
    connections: new Map(),
  };
  requestScopes.set(scopedEnv, state);

  return {
    env: scopedEnv,
    close: () => closeRequestScope(state),
  };
}

function readScopedDb(
  scope: RequestScopeState,
  kind: ConnectionKind,
  resolveConnectionString: () => string,
): DoxaDb {
  if (scope.closing) throw createClosedScopeError();

  const existing = scope.connections.get(kind);
  if (existing) return existing.db;

  const pool = scope.pools.acquire(resolveConnectionString());
  const connection = { pool, db: createDrizzle(pool) };
  scope.connections.set(kind, connection);
  return connection.db;
}

function closeRequestScope(scope: RequestScopeState): Promise<void> {
  scope.closing ??= endScopedPools(scope);
  return scope.closing;
}

async function endScopedPools(scope: RequestScopeState): Promise<void> {
  const pools = [...scope.connections.values()].map(({ pool }) => pool);
  scope.connections.clear();
  await Promise.all(pools.map((pool) => scope.pools.release(pool)));
}

function createClosedScopeError(): Error {
  return new Error(
    "This request database scope is closed. Create a new scope with createRequestDbScope() for each request.",
  );
}

function resolveFreshConnectionString(env: DbEnv): string {
  const fromCacheDisabledHyperdrive = env.HYPERDRIVE_CACHE_DISABLED?.connectionString;
  if (fromCacheDisabledHyperdrive) return fromCacheDisabledHyperdrive;

  const directConnectionString = resolveDirectConnectionString(env);
  if (directConnectionString) return directConnectionString;

  if (env.HYPERDRIVE?.connectionString) {
    throw new Error(
      "Missing HYPERDRIVE_CACHE_DISABLED. Fresh database reads must not use the cached Hyperdrive binding.",
    );
  }

  throw createMissingConnectionError();
}

function resolveCachedConnectionString(env: DbEnv): string {
  const fromCachedHyperdrive = env.HYPERDRIVE?.connectionString;
  if (fromCachedHyperdrive) return fromCachedHyperdrive;

  const directConnectionString = resolveDirectConnectionString(env);
  if (directConnectionString) return directConnectionString;

  throw createMissingConnectionError();
}

function resolveDirectConnectionString(env: DbEnv): string | undefined {
  const fromEnv = env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const fromProcess =
    typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
  if (fromProcess) return fromProcess;

  return undefined;
}

function createMissingConnectionError(): Error {
  return new Error(
    "Missing database connection. Set DATABASE_URL locally or bind Hyperdrive in Cloudflare.",
  );
}
