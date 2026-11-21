import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
