/**
 * Stand-in for `cloudflare:workers`, which only exists inside workerd.
 *
 * The Durable Object classes extend this base purely to receive `ctx` and `env`; the
 * runtime adds no behaviour that the unit tests rely on. Providing a minimal shape lets
 * suites import modules that pull in a DO (for example `src/index.ts`, which registers
 * AccountPool and RateLimiter) without pulling in the whole workerd runtime.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
