import { describe, expect, it } from "vitest"
import server from "../src/index.ts"
import root from "../index.ts"

describe("entrypoints", () => {
  it("server entrypoint exposes a no-op setup", () => {
    expect(server.setup({} as never)).toBeUndefined()
  })
  it("package root re-exports the server entrypoint", () => {
    expect(root).toBe(server)
  })
})
