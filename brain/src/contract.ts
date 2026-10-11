/**
 * The KnowledgeGraph interface (design rev 4 §4–§5) as Effect Schemas for request
 * validation, plus TypeScript types for responses. brain-caller imports this file
 * with `import type` only.
 */
import { Effect, Schema } from "effect"
import { invalid, type BrainError } from "./errors.ts"

const NonEmpty = Schema.String.check(Schema.isMinLength(1))
const Limit = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))

export const Basis = Schema.Literals(["compiler-derived", "imported", "human-asserted", "model-inferred"])
export type Basis = typeof Basis.Type

export const Entity = Schema.Struct({
  id: NonEmpty,
  type: NonEmpty,
  name: NonEmpty,
  aliases: Schema.Array(Schema.String),
})
export type Entity = typeof Entity.Type

export const Source = Schema.Struct({
  ref: NonEmpty,
  version: NonEmpty,
  at: Schema.optionalKey(Schema.String),
  quote: Schema.optionalKey(Schema.String),
  locator: Schema.optionalKey(Schema.String),
})
export type Source = typeof Source.Type

const KeyRef = Schema.Struct({ key: NonEmpty })
export const FactRef = Schema.Union([Schema.Struct({ factId: NonEmpty, revision: NonEmpty }), KeyRef])
export type FactRef = typeof FactRef.Type

export const WriteFactItem = Schema.Struct({
  key: Schema.optionalKey(NonEmpty),
  id: Schema.optionalKey(NonEmpty),
  revision: Schema.optionalKey(NonEmpty),
  subject: NonEmpty,
  predicate: NonEmpty,
  object: Schema.optionalKey(NonEmpty),
  value: Schema.optionalKey(Schema.Json),
  basis: Basis,
  /** Optional: a fact that rests only on other facts may leave it out. */
  sources: Schema.optionalKey(Schema.Array(Source)),
  basedOn: Schema.optionalKey(Schema.Array(FactRef)),
  contradicts: Schema.optionalKey(Schema.Array(Schema.Union([NonEmpty, KeyRef]))),
})
export type WriteFactItem = typeof WriteFactItem.Type

export const RetractItem = Schema.Struct({ id: NonEmpty, revision: NonEmpty, reason: NonEmpty })

export const WriteRequest = Schema.Struct({
  rationale: NonEmpty,
  entities: Schema.optionalKey(Schema.Array(Entity)),
  facts: Schema.optionalKey(Schema.Array(WriteFactItem)),
  retract: Schema.optionalKey(Schema.Array(RetractItem)),
  /** Validate and report the result without writing anything. */
  dryRun: Schema.optionalKey(Schema.Boolean),
})
export type WriteRequest = typeof WriteRequest.Type

export const GetEntityRequest = Schema.Struct({ id: NonEmpty })
export const GetFactRequest = Schema.Struct({ id: NonEmpty, includeHistory: Schema.optionalKey(Schema.Boolean) })
export const ListFactsRequest = Schema.Struct({
  subject: Schema.optionalKey(NonEmpty),
  object: Schema.optionalKey(NonEmpty),
  predicate: Schema.optionalKey(NonEmpty),
  writer: Schema.optionalKey(NonEmpty),
  staleOnly: Schema.optionalKey(Schema.Boolean),
  sourceRef: Schema.optionalKey(NonEmpty),
  sourceRefPrefix: Schema.optionalKey(NonEmpty),
  limit: Schema.optionalKey(Limit(500)),
  cursor: Schema.optionalKey(NonEmpty),
})
export type ListFactsRequest = typeof ListFactsRequest.Type
export const SearchRequest = Schema.Struct({ text: NonEmpty, limit: Schema.optionalKey(Limit(100)) })
export const NeighborsRequest = Schema.Struct({
  from: NonEmpty,
  predicates: Schema.optionalKey(Schema.Array(NonEmpty)),
  direction: Schema.optionalKey(Schema.Literals(["out", "in", "both"])),
  depth: Schema.optionalKey(Schema.Literals([1, 2, 3])),
  limit: Schema.optionalKey(Limit(500)),
})
export type NeighborsRequest = typeof NeighborsRequest.Type
export const SourceChangedRequest = Schema.Struct({ ref: NonEmpty, version: NonEmpty })

export const RegisterWriterRequest = Schema.Struct({ writerId: NonEmpty, allowedBases: Schema.Array(Basis) })
export const RotateKeyRequest = Schema.Struct({ writerId: NonEmpty })
export const ListWritersRequest = Schema.Struct({})
export const RevertWriterRequest = Schema.Struct({ writerId: NonEmpty, since: NonEmpty })

/** Decode an untrusted request body, failing with INVALID_INPUT. */
export const decode =
  <S extends Schema.Codec<any, any, never, never>>(schema: S) =>
  (input: unknown): Effect.Effect<S["Type"], BrainError> =>
    Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((e) => invalid(e.message)),
    )

// ---- Response types -------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface Fact {
  id: string
  revision: string
  subject: string
  predicate: string
  object?: string
  value?: Json
  basis: Basis
  writer: string
  recordedAt: string
  sources: Source[]
  basedOn: { factId: string; revision: string }[]
  contradicts: string[]
  status: "active" | "retracted"
  retractedReason?: string
}

export type StaleReason =
  | { ref: string; citedVersion: string; latestVersion: string }
  | { factId: string; reason: "stale" | "retracted" | "revised" }

export interface FactView {
  fact: Fact
  subjectName: string
  objectName?: string
  stale: boolean
  staleBecause: StaleReason[]
  contradictedBy: string[]
}

export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface WriteResult {
  writeId: string
  facts: Array<{ key?: string; id: string; revision: string }>
  retracted: Array<{ id: string; revision: string }>
  /** Entities this write created, and existing ones it changed (unchanged ones are in neither). */
  entities: { created: string[]; changed: string[] }
  /** Present when the request was a dry run: nothing was written. */
  dryRun?: true
}

export interface EntityResult {
  entity: Entity
  about: FactView[]
  pointingHere: FactView[]
  moreAbout: boolean
  morePointingHere: boolean
  /** Active facts about the entity per predicate; use listFacts to read the rest. */
  aboutPredicates: Record<string, number>
  pointingHerePredicates: Record<string, number>
}

export interface FactResult {
  view: FactView
  basedOn: FactView[]
  supports: FactView[]
  contradictions: FactView[]
  history?: Fact[]
}

export interface SearchResult {
  entities: Entity[]
  facts: FactView[]
}

export interface NeighborsResult {
  paths: Array<{ facts: FactView[]; end: Entity }>
  truncated: boolean
}

export interface Writer {
  id: string
  allowedBases: Basis[]
}
