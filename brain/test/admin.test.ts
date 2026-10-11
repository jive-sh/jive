import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Admin from "../src/admin.ts"
import { codeOf, runDb } from "./support.ts"

describe("writers", () => {
  test("registerWriter returns a 64-hex key that authenticates to the writer and its bases", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        const { apiKey } = yield* Admin.registerWriter({ writerId: "claude/onboarding", allowedBases: ["imported", "model-inferred"] })
        const writer = yield* Admin.authenticate(apiKey)
        return { apiKey, writer }
      }),
    )
    expect(result.apiKey).toMatch(/^[0-9a-f]{64}$/)
    expect(result.writer).toEqual({ id: "claude/onboarding", allowedBases: ["imported", "model-inferred"] })
  }, 30_000)

  test("authenticate rejects an unknown key", async () => {
    expect(await runDb(codeOf(Admin.authenticate("nope")))).toBe("UNAUTHENTICATED")
  }, 30_000)

  test("registering an existing writer id fails INVALID_INPUT", async () => {
    const code = await runDb(
      Effect.gen(function* () {
        yield* Admin.registerWriter({ writerId: "w", allowedBases: ["imported"] })
        return yield* codeOf(Admin.registerWriter({ writerId: "w", allowedBases: ["imported"] }))
      }),
    )
    expect(code).toBe("INVALID_INPUT")
  }, 30_000)

  test("rotateKey invalidates the old key and returns a working new one", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        const { apiKey: oldKey } = yield* Admin.registerWriter({ writerId: "w", allowedBases: ["imported"] })
        const { apiKey: newKey } = yield* Admin.rotateKey({ writerId: "w" })
        return { old: yield* codeOf(Admin.authenticate(oldKey)), fresh: (yield* Admin.authenticate(newKey)).id }
      }),
    )
    expect(result).toEqual({ old: "UNAUTHENTICATED", fresh: "w" })
  }, 30_000)

  test("listWriters lists ids and bases", async () => {
    const writers = await runDb(
      Effect.gen(function* () {
        yield* Admin.registerWriter({ writerId: "a", allowedBases: ["imported"] })
        yield* Admin.registerWriter({ writerId: "b", allowedBases: ["compiler-derived"] })
        return yield* Admin.listWriters()
      }),
    )
    expect(writers.map((w) => [w.writerId, w.allowedBases])).toEqual([["a", ["imported"]], ["b", ["compiler-derived"]]])
  }, 30_000)
})
