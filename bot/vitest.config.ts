/**
 * Vitest for the bot half of Vaticr.
 *
 * Scoped to `src/**` so the runner never picks up the Hardhat suite under
 * test/ (mocha globals) or the Python suite under tests/. Node environment:
 * nothing here touches a DOM, and the strategy under test is pure.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
