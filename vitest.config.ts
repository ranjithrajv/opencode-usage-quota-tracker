import solid from "vite-plugin-solid"
import { defineConfig, type Plugin } from "vitest/config"

// v8 coverage cannot attribute blocks to modules that only re-export a
// default binding (ast-v8-to-istanbul produces empty maps for them), so the
// root `index.ts` re-export is excluded from the coverage include list; its
// re-export semantics are asserted by entrypoints.test.ts (`root === server`).
// For `src/index.ts` the bare `export default <expr>` is hoisted into a named
// binding (behavior-unchanged) so the file reports coverage.
function hoistDefaultExports(): Plugin {
  return {
    name: "hoist-default-exports-for-coverage",
    transform(code: string, id: string) {
      if (id.endsWith("src/index.ts") && code.includes("export default ")) {
        return {
          code: code.replace("export default ", "const _default = ") + "\nexport default _default\n",
          map: null,
        }
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [hoistDefaultExports(), solid({ hot: false })],
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: "solid-js/dist/dev.js" },
      { find: /^solid-js\/web$/, replacement: "solid-js/web/dist/dev.js" },
    ],
    conditions: ["browser", "development"],
  },
  test: {
    environment: "happy-dom",
    // The kit ships TypeScript source; inline it so Vite transpiles it
    // (a linked checkout is processed anyway, but a registry install isn't).
    server: { deps: { inline: [/opencode-plugin-kit/] } },
    include: ["**/*.test.ts", "**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["json", "text"],
      include: ["src/index.ts", "tui.tsx"],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
})
