import * as e from "effect";
import type { NotInWorkspaceError, RepoIdentifier, VerifyRepoIntegrityError } from "@/modules/tool-state/interface";
import type { BadArgumentError, BadPreconditionsError } from "..";

export class IBun extends e.Context.Tag("IBun")<IBun, {
  // TODO: should I just expose run directly?
  readonly install: (repo: RepoIdentifier) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly link: (repo: RepoIdentifier) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
  readonly unlink: (repo: RepoIdentifier) => e.Effect.Effect<void, BadArgumentError | BadPreconditionsError>;
}>() {}
