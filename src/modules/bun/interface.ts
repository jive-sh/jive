import type { EffectGen } from "effective-modules";
import type { BadArgumentError, BadPreconditionsError } from "@/errors";
import type { RepoIdentifier } from "@/modules/tool-state/repo-identifier";

export interface IBun {
  install(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  link(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
  unlink(repo: RepoIdentifier): EffectGen<void, BadArgumentError | BadPreconditionsError>;
}
