import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// `obsidian` ships types only; the stub gives the few runtime names the index needs.
		alias: { obsidian: fileURLToPath(new URL("./tests/unit/stubs/obsidian.ts", import.meta.url)) },
	},
	test: {
		// Unit tests are pure logic (objectPath, queryCache core, globals) with no
		// Obsidian runtime. E2E/canary tests run outside vitest (tests/e2e, §14).
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
	},
});
