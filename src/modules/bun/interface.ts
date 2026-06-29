import type { RepoIdentifier } from "@/modules/tool-state/interface";
import type { BadArgumentError, BadPreconditionsError } from "..";
import type { GenEffect } from "@/temp-libs/effective-modules";

export interface IBun {
  // TODO: should I just expose run directly?
  install(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  link(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError>;
  unlink(repo: RepoIdentifier): GenEffect<void, BadArgumentError | BadPreconditionsError>;
}
