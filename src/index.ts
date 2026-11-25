import { createApp } from "./app.js";
import type { Env } from "./env.js";
import { sweep } from "./scheduled.js";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;
