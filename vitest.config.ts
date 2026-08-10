import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests (*.db.test.ts) skip themselves when the database or
    // Ollama is unreachable; no separate config needed.
  },
});
