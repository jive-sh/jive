import * as e from "effect";
import type { RepoIdentifier } from "@/modules/tool-state/interface";

export class IBun extends e.Context.Tag("IBun")<IBun, {
  // TODO: should I just expose run directly?
  readonly install: (repo: RepoIdentifier) => e.Effect.Effect<void>;
  readonly link: (repo: RepoIdentifier) => e.Effect.Effect<void>;
  readonly unlink: (repo: RepoIdentifier) => e.Effect.Effect<void>;
}>() {}
