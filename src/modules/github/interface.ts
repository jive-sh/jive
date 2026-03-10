import * as e from "effect";
import type { GitService } from "../git/interface";
import type { PendingGitHubLogin } from "./service";
import type { GitHubJiveKeyInventory, GitHubSession, YubiKeyJiveKey } from "../auth/types";

export interface GitHubService {
  readonly requiredCLICommands: readonly string[];
  readonly isOAuthConfigured: () => boolean;
  readonly beginReadOnlyLogin: (options?: { readonly openBrowser?: boolean }) => PendingGitHubLogin;
  readonly beginWriteLogin: (options?: { readonly openBrowser?: boolean }) => PendingGitHubLogin;
  readonly renewWriteTokenFromRefresh: (refreshToken: string) => e.Effect.Effect<e.Option.Option<GitHubSession>>;
  readonly isWriteCapableScope: (scopeList: string) => boolean;
  readonly isReadScopeSatisfied: (scopeList: string) => boolean;
  readonly getVerifiedEmails: (githubToken: string) => e.Effect.Effect<string[]>;
  readonly listJiveKeys: (githubToken: string) => e.Effect.Effect<e.Option.Option<GitHubJiveKeyInventory>>;
  readonly ensureSigningJiveKey: (
    githubToken: string,
    key: YubiKeyJiveKey,
    knownJiveInventory?: e.Option.Option<GitHubJiveKeyInventory>,
  ) => e.Effect.Effect<void>;
  readonly ensureAuthKey: (
    githubToken: string,
    keyName: string,
    publicKey: string,
    knownJiveInventory?: e.Option.Option<GitHubJiveKeyInventory>,
  ) => e.Effect.Effect<void>;
  readonly remoteRepos: (org: string, readOnlyToken?: string) => e.Effect.Effect<string[]>;
  readonly repoDefaultBranch: (org: string, repo: string, readOnlyToken: string) => e.Effect.Effect<e.Option.Option<string>>;
  readonly checkWorkspaceRepoAccess: (
    root: string,
    githubToken: string,
    git: Pick<GitService, "localOrgs" | "localRepos">,
  ) => e.Effect.Effect<void>;
}

export class IGitHub extends e.Context.Tag("IGitHub")<IGitHub, GitHubService>() {}
