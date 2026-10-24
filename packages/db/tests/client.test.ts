import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCachedDb,
  createCachedPgPool,
  createDb,
  createPgPool,
  createRequestDbScope,
  createSharedPgPoolProvider,
  usePgPoolProvider,
  type DbEnv,
} from "../src/client";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }

  process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("database connection selection", () => {
  it("uses the cache-disabled Hyperdrive binding for the default pool", async () => {
    const pool = createPgPool({
      HYPERDRIVE: { connectionString: "postgresql://cached.example/doxa" },
      HYPERDRIVE_CACHE_DISABLED: {
        connectionString: "postgresql://fresh.example/doxa",
      },
    });

    expect(pool.options.connectionString).toBe("postgresql://fresh.example/doxa");
    await pool.end();
  });

  it("uses the cached Hyperdrive binding only for an explicit cached pool", async () => {
    const pool = createCachedPgPool({
      HYPERDRIVE: { connectionString: "postgresql://cached.example/doxa" },
      HYPERDRIVE_CACHE_DISABLED: {
        connectionString: "postgresql://fresh.example/doxa",
      },
    });

    expect(pool.options.connectionString).toBe("postgresql://cached.example/doxa");
    await pool.end();
  });

  it("uses DATABASE_URL for local development", async () => {
    const pool = createPgPool({
      DATABASE_URL: "postgresql://localhost/doxa",
    });

    expect(pool.options.connectionString).toBe("postgresql://localhost/doxa");
    await pool.end();
  });

  it("does not silently use cached Hyperdrive for fresh reads", () => {
    delete process.env.DATABASE_URL;

    expect(() =>
      createPgPool({
        HYPERDRIVE: { connectionString: "postgresql://cached.example/doxa" },
      }),
    ).toThrow(/HYPERDRIVE_CACHE_DISABLED/);
  });
});

const scopeEnv: DbEnv = {
  HYPERDRIVE: { connectionString: "postgresql://cached.example/doxa" },
  HYPERDRIVE_CACHE_DISABLED: {
    connectionString: "postgresql://fresh.example/doxa",
  },
};

// pg pools connect lazily, so these pools never open a socket.
function createRecordingPoolFactory() {
  const pools: Pool[] = [];
  const createPool = (connectionString: string) => {
    const pool = new Pool({ connectionString });
    vi.spyOn(pool, "end");
    pools.push(pool);
    return pool;
  };
  return { pools, createPool };
}

describe("request database scope", () => {
  it("returns one database instance for the same scoped env", async () => {
    const factory = createRecordingPoolFactory();
    const scope = createRequestDbScope(scopeEnv, factory);

    expect(createDb(scope.env)).toBe(createDb(scope.env));
    expect(factory.pools).toHaveLength(1);
    await scope.close();
  });

  it("keeps separate fresh and cached connections", async () => {
    const factory = createRecordingPoolFactory();
    const scope = createRequestDbScope(scopeEnv, factory);

    const fresh = createDb(scope.env);
    const cached = createCachedDb(scope.env);

    expect(fresh).not.toBe(cached);
    expect(createCachedDb(scope.env)).toBe(cached);
    expect(factory.pools.map((pool) => pool.options.connectionString)).toEqual([
      "postgresql://fresh.example/doxa",
      "postgresql://cached.example/doxa",
    ]);
    await scope.close();
  });

  it("gives each scope its own instance", async () => {
    const first = createRequestDbScope(scopeEnv, createRecordingPoolFactory());
    const second = createRequestDbScope(scopeEnv, createRecordingPoolFactory());

    expect(first.env).not.toBe(second.env);
    expect(createDb(first.env)).not.toBe(createDb(second.env));
    await Promise.all([first.close(), second.close()]);
  });

  it("copies the env without changing the original", () => {
    const scope = createRequestDbScope(scopeEnv);

    expect(scope.env).not.toBe(scopeEnv);
    expect(scope.env).toEqual(scopeEnv);
  });

  it("does not create a pool until a database is requested", async () => {
    const factory = createRecordingPoolFactory();
    const scope = createRequestDbScope(scopeEnv, factory);

    await scope.close();
    expect(factory.pools).toHaveLength(0);
  });

  it("ends every created pool once, even when closed twice", async () => {
    const factory = createRecordingPoolFactory();
    const scope = createRequestDbScope(scopeEnv, factory);
    createDb(scope.env);
    createCachedDb(scope.env);

    await scope.close();
    await scope.close();

    expect(factory.pools).toHaveLength(2);
    for (const pool of factory.pools) {
      expect(pool.end).toHaveBeenCalledTimes(1);
      expect(pool.ended).toBe(true);
    }
  });

  it("rejects database requests after close", async () => {
    const scope = createRequestDbScope(scopeEnv, createRecordingPoolFactory());
    await scope.close();

    expect(() => createDb(scope.env)).toThrow(/request database scope is closed/);
    expect(() => createCachedDb(scope.env)).toThrow(
      /request database scope is closed/,
    );
  });

  it("leaves unscoped envs on a new pool for each call", () => {
    const scope = createRequestDbScope(scopeEnv, createRecordingPoolFactory());
    const scopedDb = createDb(scope.env);

    const unscopedFirst = createDb(scopeEnv);
    const unscopedSecond = createDb(scopeEnv);

    expect(unscopedFirst).not.toBe(unscopedSecond);
    expect(unscopedFirst).not.toBe(scopedDb);
    return Promise.all([
      unscopedFirst.$client.end(),
      unscopedSecond.$client.end(),
      scope.close(),
    ]);
  });
});

describe("shared pool provider", () => {
  it("serves every scope and every unscoped call from one pool per connection", async () => {
    const shared = createSharedPgPoolProvider({ max: 20 });
    const previous = usePgPoolProvider(shared);
    try {
      const first = createRequestDbScope(scopeEnv);
      const second = createRequestDbScope(scopeEnv);

      const firstPool = createDb(first.env).$client;
      expect(createDb(second.env).$client).toBe(firstPool);
      expect(createDb(scopeEnv).$client).toBe(firstPool);
      expect(createCachedDb(scopeEnv).$client).not.toBe(firstPool);
      expect(firstPool.options.max).toBe(20);

      await Promise.all([first.close(), second.close()]);
      expect(firstPool.ended).toBe(false);
    } finally {
      usePgPoolProvider(previous);
      await shared.close();
    }
  });

  it("ends its pools on close", async () => {
    const shared = createSharedPgPoolProvider({ max: 2 });
    const pool = shared.acquire("postgresql://fresh.example/doxa");

    await shared.close();

    expect(pool.ended).toBe(true);
    expect(shared.acquire("postgresql://fresh.example/doxa")).not.toBe(pool);
    await shared.close();
  });
});
