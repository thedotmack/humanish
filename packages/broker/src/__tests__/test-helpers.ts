// Test helpers: in-memory KV + hand-rolled DurableObjectStorage / state mocks.
//
// IMPORTANT: these are mocks, NOT the real Cloudflare Workers runtime. They model
// the API surface exercised by bearer.ts and slug-box.ts (get/put/delete with TTL
// for KV; get/put/delete for DO storage). For the MVP, this is enough to assert
// correctness of the security-critical logic; we accept that we do not exercise:
//   - KV eventual-consistency edges
//   - real DO single-threading guarantees (we simulate them with a per-instance
//     serial-call wrapper in MockDurableObjectState.fetch — see SlugBox tests)
//   - workerd-specific behavior (e.g. clone semantics on Request body)
//
// If/when broker logic depends on those, switch to @cloudflare/vitest-pool-workers.

export interface KVPutOptions {
  expirationTtl?: number;
  expiration?: number;
}

interface Entry {
  value: string;
  expiresAt?: number;
}

// Minimal KVNamespace surface used by bearer.ts and friends. Matches the
// shape of the methods we call from production code; we don't try to model
// every overload of KVNamespace.put / .get from @cloudflare/workers-types.
export class MockKVNamespace {
  private store = new Map<string, Entry>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: KVPutOptions): Promise<void> {
    const entry: Entry = { value };
    if (opts?.expirationTtl !== undefined) {
      entry.expiresAt = Date.now() + opts.expirationTtl * 1000;
    } else if (opts?.expiration !== undefined) {
      entry.expiresAt = opts.expiration * 1000;
    }
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // Test-only helper.
  _rawSize(): number {
    return this.store.size;
  }
}

// Minimal DurableObjectStorage surface for SlugBox.
class MockDurableObjectStorage {
  private map = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}

// Minimal DurableObjectState surface. The real one has more (id, blockConcurrencyWhile,
// transactions, alarms) but SlugBox only touches storage.
class MockDurableObjectState {
  storage = new MockDurableObjectStorage();
}

// SlugBox calls into a DurableObject-like instance; we instantiate the class
// directly with these mocks. The mockEnv argument is unused by SlugBox today
// but kept for symmetry with the real signature.
export function makeMockDurableObjectState(): unknown {
  return new MockDurableObjectState();
}

// Serialize calls to an async handler to model the Cloudflare Durable Object
// per-instance single-threaded contract: at most ONE in-flight fetch handler
// per DO instance, queued FIFO. Tests that want to simulate "parallel" requests
// (in the sense of "the caller fires several at once") wrap the SlugBox instance
// with this and then Promise.all() the kicked-off promises.
export function makeSerializedFetch(
  realFetch: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  let queue: Promise<unknown> = Promise.resolve();
  return (req: Request) => {
    const run = queue.then(() => realFetch(req));
    queue = run.catch(() => {
      // Swallow the rejection on the queue chain so one failing call does
      // not block subsequent calls. The original promise is still returned
      // to the caller so they see the rejection.
    });
    return run;
  };
}

// Build an Env-shaped object with just the KV binding (the only Env field
// bearer.ts touches in the code paths we test).
export interface BearerTestEnv {
  KV: MockKVNamespace;
}

export function makeBearerEnv(): BearerTestEnv {
  return { KV: new MockKVNamespace() };
}
