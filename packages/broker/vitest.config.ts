import { defineConfig } from "vitest/config";

// We intentionally run broker tests in Node rather than @cloudflare/vitest-pool-workers
// for the MVP:
//
//   - The tests in src/__tests__/ stub the KV and DurableObjectStorage surfaces
//     with hand-rolled in-memory mocks (see comments in each test file). The
//     bearer + slug-box logic under test is pure TypeScript over those KV/storage
//     APIs — no Workers-only globals are needed.
//   - This avoids pinning the whole workspace to vitest 4.x (vitest-pool-workers'
//     current peer dep) and keeps test runs fast without a miniflare boot.
//   - The Workers runtime gives stronger guarantees (real DO single-threading,
//     real KV consistency model). When the broker grows code that exercises
//     those, swap this config for defineWorkersConfig().
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
