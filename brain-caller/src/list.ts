import { Effect } from "effect"
import { kg, type Connection } from "./client.ts"

/** listFacts, optionally following cursors to the end. */
export const listAll = (connection: Connection, filter: Record<string, unknown>, cursor: string | undefined, all: boolean) =>
  Effect.gen(function* () {
    const items: unknown[] = []
    let next = cursor
    do {
      const page = yield* kg<{ items: unknown[]; nextCursor?: string }>(connection, "listFacts", { ...filter, ...(next ? { cursor: next } : {}) })
      items.push(...page.items)
      next = page.nextCursor
      if (!all) return page
    } while (next)
    return { items }
  })
