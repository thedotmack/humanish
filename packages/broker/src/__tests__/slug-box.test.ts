// Tests for SlugBox (the per-slug one-shot Durable Object).
//
// LIMITATION: these tests run in node-env and instantiate the SlugBox class
// directly with hand-rolled DurableObjectState + storage mocks (from
// ./test-helpers.ts), NOT against the real workerd Durable Object runtime.
//
// We model the per-instance single-threading guarantee by wrapping fetch()
// in makeSerializedFetch() — every parallel-looking call is queued FIFO. That
// is enough to verify SlugBox's semantic contract (claim once, consume once,
// 410 on second consume, race resolves to exactly one winner).
//
// Anything that depends on the real DO runtime's `blockConcurrencyWhile`,
// alarms, or transactional storage is out of scope. When that matters, swap
// to @cloudflare/vitest-pool-workers (see ../../vitest.config.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { SlugBox } from "../slug-box.js";
import {
  makeMockDurableObjectState,
  makeSerializedFetch,
} from "./test-helpers.js";

// SlugBox's constructor takes (state, env). The env arg is unused in the
// production code so we pass a stub.
const NO_ENV = {} as unknown as Env;

function makeSlugBox() {
  const state = makeMockDurableObjectState() as DurableObjectState;
  const slugBox = new SlugBox(state, NO_ENV);
  // Serialize fetch calls to model the real DO single-threaded contract.
  const serializedFetch = makeSerializedFetch((req) => slugBox.fetch(req));
  return { slugBox, fetch: serializedFetch };
}

const CLAIM_URL = "http://slug.box/claim";
const CONSUME_URL = "http://slug.box/consume";

const examplePayload = {
  markdown: "# claim me",
  scope: {
    profile: "alice",
    action_id: "google.whoami",
    payload_shape_hash: "abc",
    ttl_seconds: 600,
  },
};

describe("SlugBox /claim", () => {
  it("first claim returns 201", async () => {
    const { fetch } = makeSlugBox();
    const res = await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify(examplePayload),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("second claim on the same instance returns 409", async () => {
    const { fetch } = makeSlugBox();
    const first = await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify(examplePayload),
      }),
    );
    expect(first.status).toBe(201);
    const second = await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify({ markdown: "# different", scope: examplePayload.scope }),
      }),
    );
    expect(second.status).toBe(409);
  });
});

describe("SlugBox /consume", () => {
  it("returns 410 if no claim has been made", async () => {
    const { fetch } = makeSlugBox();
    const res = await fetch(new Request(CONSUME_URL, { method: "GET" }));
    expect(res.status).toBe(410);
  });

  it("returns 200 + the claimed payload on first consume after claim", async () => {
    const { fetch } = makeSlugBox();
    const claim = await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify(examplePayload),
      }),
    );
    expect(claim.status).toBe(201);
    const consume = await fetch(new Request(CONSUME_URL, { method: "GET" }));
    expect(consume.status).toBe(200);
    const body = await consume.json();
    expect(body).toEqual(examplePayload);
  });

  it("second consume after first returns 410 (single-shot)", async () => {
    const { fetch } = makeSlugBox();
    await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify(examplePayload),
      }),
    );
    const first = await fetch(new Request(CONSUME_URL, { method: "GET" }));
    expect(first.status).toBe(200);
    const second = await fetch(new Request(CONSUME_URL, { method: "GET" }));
    expect(second.status).toBe(410);
  });
});

describe("SlugBox parallel consume race", () => {
  it("exactly one of N concurrent consumes wins; the rest see 410", async () => {
    const { fetch } = makeSlugBox();
    await fetch(
      new Request(CLAIM_URL, {
        method: "POST",
        body: JSON.stringify(examplePayload),
      }),
    );

    // Fire 10 concurrent consume requests. The serialized-fetch wrapper
    // models the real DO single-threading guarantee — they will run in FIFO
    // order, and exactly one will see the value before delete.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(new Request(CONSUME_URL, { method: "GET" })),
      ),
    );
    const successes = responses.filter((r) => r.status === 200);
    const gone = responses.filter((r) => r.status === 410);
    expect(successes.length).toBe(1);
    expect(gone.length).toBe(9);
  });
});

describe("SlugBox unsupported routes", () => {
  let fetcher: (req: Request) => Promise<Response>;
  beforeEach(() => {
    ({ fetch: fetcher } = makeSlugBox());
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetcher(
      new Request("http://slug.box/whatever", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for /claim with GET (wrong method)", async () => {
    const res = await fetcher(new Request(CLAIM_URL, { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 for /consume with POST (wrong method)", async () => {
    const res = await fetcher(new Request(CONSUME_URL, { method: "POST" }));
    expect(res.status).toBe(404);
  });
});
