import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/testSetup/globalSetup.ts"],
    testTimeout: 15000,
    // All test files share one real Postgres (globalSetup runs migrations
    // once, no per-file schema), and several files' afterEach hooks TRUNCATE
    // the same tables (users/sessions, shared by authService.test.ts and
    // middleware/auth.test.ts). Vitest's default file parallelism otherwise
    // lets one file's truncate race another file's in-flight test against
    // the same rows — caught the hard way as an intermittent
    // sessions_user_id_fkey violation, not consistently reproducible since
    // it depends on scheduling.
    fileParallelism: false,
  },
});
