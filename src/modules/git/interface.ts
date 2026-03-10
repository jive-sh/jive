import * as e from "effect";

export interface GitIdentity {
  readonly userName: string;
  readonly userEmail: string;
  readonly authPrivateKeyPath: string;
  readonly signingPublicKey?: string;
}

export type SubmoduleUpdateResult =
  | { readonly _tag: "Updated" }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "SkippedDirty" }
  | { readonly _tag: "SkippedUnknownDefaultBranch" }
  | { readonly _tag: "SkippedOffDefaultBranch"; readonly currentBranch: string; readonly defaultBranch: string }
  | { readonly _tag: "SkippedPullFailed" };

export interface GitService {
  readonly requiredCLICommands: readonly string[];
  readonly localOrgs: e.Effect.Effect<string[]>;
  readonly localRepos: (org: string) => e.Effect.Effect<string[]>;
  readonly submoduleExists: (org: string, repo: string) => e.Effect.Effect<boolean>;
  readonly addSubmodule: (org: string, repo: string) => e.Effect.Effect<boolean>;
  readonly removeSubmodule: (org: string, repo: string) => e.Effect.Effect<boolean>;
  readonly updateSubmoduleIfAllowed: (
    org: string,
    repo: string,
    defaultBranch: e.Option.Option<string>,
  ) => e.Effect.Effect<SubmoduleUpdateResult>;
  readonly configureRepoRemoteAndUser: (org: string, repo: string, identity: GitIdentity) => e.Effect.Effect<boolean>;
  readonly runInRepo: (org: string, repo: string, command: readonly string[]) => e.Effect.Effect<boolean>;
}

export class IGit extends e.Context.Tag("IGit")<IGit, GitService>() {}
