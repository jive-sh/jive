import * as e from "effect";

export class IBun extends e.Context.Tag("IBun")<IBun, {
  readonly install: (org: string, repo: string) => e.Effect.Effect<void>;
  readonly link: (org: string, repo: string) => e.Effect.Effect<void>;
  readonly unlink: (org: string, repo: string) => e.Effect.Effect<void>;
}>() {}
