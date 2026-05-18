// SlugBox: per-slug Durable Object holding a one-shot payload (markdown + scope).
//
// Atomicity contract: in /consume, the storage.get() and storage.delete() calls
// MUST be back-to-back with no intervening await. Because Durable Objects single-
// thread requests per-instance, and storage operations within a single execution
// turn are serialized, this pattern guarantees exactly-one consumer.
//
// CI grep guard (Phase 7) enforces no extra awaits between get and delete here.

export class SlugBox {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/claim") {
      const existing = await this.state.storage.get("v");
      if (existing) return new Response(null, { status: 409 });
      const payload = await req.json();
      await this.state.storage.put("v", payload);
      return new Response(null, { status: 201 });
    }

    if (req.method === "GET" && url.pathname === "/consume") {
      const v = await this.state.storage.get("v");
      if (!v) return new Response(null, { status: 410 });
      // CRITICAL: no await between get above and delete below. Single-shot semantics.
      await this.state.storage.delete("v");
      return Response.json(v);
    }

    return new Response(null, { status: 404 });
  }
}
