import { Effect, Layer } from "effect"
import { Query } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import type { Basis, Writer } from "../src/contract.ts"
import { Db } from "../src/db/client.ts"
import { tables } from "../src/db/tables.ts"
import { BrainError } from "../src/errors.ts"

/** Run an effect against a fresh in-memory database, with optional extra layers. */
export const runDb = <A, E>(effect: Effect.Effect<A, E, any>, extra?: Layer.Layer<any, any, any>): Promise<A> => {
  const db = Db.layer({ dataDir: "memory://" })
  const layer = extra ? Layer.provideMerge(extra, db) : db
  return Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)) as Effect.Effect<A, E, never>)
}

/** The error code an effect fails with, or "OK". */
export const codeOf = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, never, R> =>
  effect.pipe(
    Effect.map(() => "OK"),
    Effect.catch((e: unknown) => Effect.succeed(e instanceof BrainError ? e.code : `UNEXPECTED: ${String(e)}`)),
  )

const allBases: Basis[] = ["compiler-derived", "imported", "human-asserted", "model-inferred"]

/** Insert a writer row directly and return it. */
export const writer = (id: string, allowedBases: Basis[] = allBases) =>
  Pg.Executor.make()
    .execute(Query.insert(tables.writers, { id, keyHash: `hash-${id}`, allowedBases }))
    .pipe(Effect.as<Writer>({ id, allowedBases }))

export const src = (ref: string, version = "v1", extra: Record<string, string> = {}) => ({ ref, version, ...extra })
export const ent = (id: string, name = id, aliases: string[] = []) => ({ id, type: id.split("/")[0]!, name, aliases })
