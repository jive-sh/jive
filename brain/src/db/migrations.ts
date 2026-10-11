/** Version 1: DDL for design rev 4 §6.2. Every statement is idempotent, so databases created before versioning re-run it harmlessly. */
const v1: ReadonlyArray<string> = [
  `create extension if not exists vector`,
  `create table if not exists writers (
    id text primary key,
    key_hash text not null unique,
    allowed_bases text[] not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists writes (
    id text primary key,
    actor text not null,
    kind text not null,
    rationale text not null,
    created_at timestamptz not null default clock_timestamp()
  )`,
  `create table if not exists entities (
    id text primary key,
    type text not null,
    name text not null,
    aliases text[] not null default '{}',
    search_keys text[] not null default '{}'
  )`,
  `create index if not exists entities_search_keys on entities using gin (search_keys)`,
  `create table if not exists entity_history (
    seq bigserial primary key,
    entity_id text not null,
    write_id text not null,
    before jsonb,
    after jsonb not null
  )`,
  `create index if not exists entity_history_entity on entity_history (entity_id, seq)`,
  `create index if not exists entity_history_write on entity_history (write_id)`,
  // facts: one row per fact, denormalising the current revision's key columns for indexed reads.
  `create table if not exists facts (
    id text primary key,
    writer text not null,
    current_revision text not null,
    subject text not null,
    predicate text not null,
    object text,
    status text not null,
    recorded_at timestamptz not null,
    created_at timestamptz not null
  )`,
  `create index if not exists facts_subject on facts (subject, recorded_at desc, id desc)`,
  `create index if not exists facts_object on facts (object, recorded_at desc, id desc) where object is not null`,
  `create index if not exists facts_predicate on facts (predicate)`,
  `create index if not exists facts_writer on facts (writer, recorded_at desc, id desc)`,
  `create index if not exists facts_recorded on facts (recorded_at desc, id desc)`,
  `create table if not exists fact_revisions (
    revision text primary key,
    fact_id text not null,
    seq integer not null,
    write_id text not null,
    recorded_at timestamptz not null,
    subject text not null,
    predicate text not null,
    object text,
    value jsonb,
    has_value boolean not null,
    basis text not null,
    status text not null,
    retracted_reason text,
    text text not null,
    text_hash text not null,
    tsv tsvector generated always as (to_tsvector('english', text)) stored,
    unique (fact_id, seq)
  )`,
  `create index if not exists fact_revisions_tsv on fact_revisions using gin (tsv)`,
  `create index if not exists fact_revisions_text_hash on fact_revisions (text_hash)`,
  `create index if not exists fact_revisions_write on fact_revisions (write_id)`,
  `create table if not exists fact_sources (
    revision text not null,
    idx integer not null,
    ref text not null,
    version text not null,
    at text,
    quote text,
    locator text,
    primary key (revision, idx)
  )`,
  `create index if not exists fact_sources_ref on fact_sources (ref text_pattern_ops)`,
  `create table if not exists fact_based_on (
    revision text not null,
    idx integer not null,
    target_fact text not null,
    target_revision text not null,
    primary key (revision, idx)
  )`,
  `create index if not exists fact_based_on_target on fact_based_on (target_fact)`,
  `create table if not exists fact_contradicts (
    revision text not null,
    target_fact text not null,
    primary key (revision, target_fact)
  )`,
  `create index if not exists fact_contradicts_target on fact_contradicts (target_fact)`,
  `create table if not exists source_reports (
    seq bigserial primary key,
    ref text not null,
    version text not null,
    write_id text not null,
    reported_at timestamptz not null default clock_timestamp(),
    reverted boolean not null default false
  )`,
  `create index if not exists source_reports_ref on source_reports (ref, seq desc) where not reverted`,
  `create index if not exists source_reports_write on source_reports (write_id)`,
  // Embeddings are keyed by the text's hash, so identical texts share one vector and a
  // renamed entity's facts are re-embedded automatically when their text changes.
  `create table if not exists fact_embeddings (
    text_hash text primary key,
    embedding vector(384) not null
  )`,
  `create index if not exists fact_embeddings_hnsw on fact_embeddings using hnsw (embedding vector_cosine_ops)`,
  `create or replace view source_latest as
    select distinct on (ref) ref, version, seq from source_reports where not reverted order by ref, seq desc`,
]

/**
 * Version 2: full-text search also indexes identifiers split into words, so
 * `LoadPostingRequestSchemaValidator` matches "load posting validated".
 */
const v2: ReadonlyArray<string> = [
  `drop index if exists fact_revisions_tsv`,
  `alter table fact_revisions drop column if exists tsv`,
  `alter table fact_revisions add column tsv tsvector generated always as (
    to_tsvector('english', text || ' ' || regexp_replace(regexp_replace(text, '([a-z0-9])([A-Z])', '\\1 \\2', 'g'), '[^A-Za-z0-9]+', ' ', 'g'))
  ) stored`,
  `create index if not exists fact_revisions_tsv on fact_revisions using gin (tsv)`,
]

/** Version 3: an explicit embedding queue, backfilled with every current text that has no vector. */
const v3: ReadonlyArray<string> = [
  `create table if not exists embedding_queue (text_hash text primary key, text text not null, priority smallint not null)`,
  `create index if not exists embedding_queue_order on embedding_queue (priority, text_hash)`,
  `insert into embedding_queue (text_hash, text, priority)
    select r.text_hash, min(r.text), min(case when r.basis = 'compiler-derived' then 1 else 0 end)
    from facts f
    join fact_revisions r on r.revision = f.current_revision
    left join fact_embeddings e on e.text_hash = r.text_hash
    where f.status = 'active' and e.text_hash is null
    group by r.text_hash
    on conflict (text_hash) do nothing`,
]

export const migrations: ReadonlyArray<{ readonly version: number; readonly statements: ReadonlyArray<string> }> = [
  { version: 1, statements: v1 },
  { version: 2, statements: v2 },
  { version: 3, statements: v3 },
]
