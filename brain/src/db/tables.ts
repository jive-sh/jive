/** effect-qb models of the §6.2 tables. DDL lives in migrations.ts; `Column.default` here only marks a column optional on insert so the database default applies. */
import { Casing, Column, Query, Table } from "effect-qb"
import * as Pg from "effect-qb/postgres"
import { Schema } from "effect"

const Snake = Casing.make("snake_case")
const Json = Schema.Unknown as Schema.Codec<unknown>

export const tables = {
  writers: Snake.table("writers", {
    id: Column.text().pipe(Column.primaryKey),
    keyHash: Column.text().pipe(Column.unique),
    allowedBases: Column.text().pipe(Pg.Column.array()),
    createdAt: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
  }),
  writes: Snake.table("writes", {
    id: Column.text().pipe(Column.primaryKey),
    actor: Column.text(),
    kind: Column.text(),
    rationale: Column.text(),
    createdAt: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
  }),
  entities: Snake.table("entities", {
    id: Column.text().pipe(Column.primaryKey),
    type: Column.text(),
    name: Column.text(),
    aliases: Column.text().pipe(Pg.Column.array()),
    searchKeys: Column.text().pipe(Pg.Column.array()),
  }),
  entityHistory: Snake.table("entity_history", {
    seq: Pg.Column.int8().pipe(Column.primaryKey, Column.default(Query.literal(0))),
    entityId: Column.text(),
    writeId: Column.text(),
    before: Pg.Column.jsonb(Json).pipe(Column.nullable),
    after: Pg.Column.jsonb(Json),
  }),
  facts: Snake.table("facts", {
    id: Column.text().pipe(Column.primaryKey),
    writer: Column.text(),
    currentRevision: Column.text(),
    subject: Column.text(),
    predicate: Column.text(),
    object: Column.text().pipe(Column.nullable),
    status: Column.text(),
    recordedAt: Pg.Column.timestamptz(),
    createdAt: Pg.Column.timestamptz(),
  }),
  factRevisions: Snake.table("fact_revisions", {
    revision: Column.text().pipe(Column.primaryKey),
    factId: Column.text(),
    seq: Column.int(),
    writeId: Column.text(),
    recordedAt: Pg.Column.timestamptz(),
    subject: Column.text(),
    predicate: Column.text(),
    object: Column.text().pipe(Column.nullable),
    value: Pg.Column.jsonb(Json).pipe(Column.nullable),
    hasValue: Column.boolean(),
    basis: Column.text(),
    status: Column.text(),
    retractedReason: Column.text().pipe(Column.nullable),
    text: Column.text(),
    textHash: Column.text(),
  }),
  factSources: Snake.table("fact_sources", {
    revision: Column.text(),
    idx: Column.int(),
    ref: Column.text(),
    version: Column.text(),
    at: Column.text().pipe(Column.nullable),
    quote: Column.text().pipe(Column.nullable),
    locator: Column.text().pipe(Column.nullable),
  }),
  factBasedOn: Snake.table("fact_based_on", {
    revision: Column.text(),
    idx: Column.int(),
    targetFact: Column.text(),
    targetRevision: Column.text(),
  }),
  factContradicts: Snake.table("fact_contradicts", {
    revision: Column.text(),
    targetFact: Column.text(),
  }),
  sourceReports: Snake.table("source_reports", {
    seq: Pg.Column.int8().pipe(Column.primaryKey, Column.default(Query.literal(0))),
    ref: Column.text(),
    version: Column.text(),
    writeId: Column.text(),
    reportedAt: Pg.Column.timestamptz().pipe(Column.default(Pg.Function.now())),
    reverted: Column.boolean().pipe(Column.default(Query.literal(false))),
  }),
}
