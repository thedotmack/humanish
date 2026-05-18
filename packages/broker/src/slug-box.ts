export class SlugBox {
  constructor(state: DurableObjectState, env: Env) {}

  async fetch(req: Request): Promise<Response> {
    return new Response(null, { status: 404 });
  }
}
