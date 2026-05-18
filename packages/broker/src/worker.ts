export { SlugBox } from "./slug-box.js";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return new Response("hello", { status: 200 });
  },
};
