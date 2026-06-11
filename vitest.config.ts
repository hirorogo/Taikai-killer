import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 自前の tests/ のみ。vendor した dashboard/ は対象外。
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dashboard", "outputs", "dist"],
  },
});
