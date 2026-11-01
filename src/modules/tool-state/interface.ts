import * as e from "effect";
import type { GithubAccessTokenType } from "@/modules/github/interface";
import type { EffectGen } from "effective-modules";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { TOOL_NAME } from "@/constants";
import { RepoIdentifier } from "./repo-identifier";
export { RepoIdentifier } from "./repo-identifier";

export interface CurrentUserState {
  readonly username: string;
  readonly email: string;
  readonly accessTokenState: TokenState;
}

export interface TokenState {
  readonly tokenType: GithubAccessTokenType;
  readonly token: string;
  readonly scope: string;
  readonly expiration: e.Option.Option<TokenExpirationState>;
}

export interface TokenExpirationState {
  readonly tokenExpiresAt: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: number;
}

export type RepoIntegrityCompromisedReason = e.Data.TaggedEnum<{
  OrgMissing: {};
  RepoMissing: {};
  SubmoduleMisconfiguration: {};
  NotAPackage: {};
}>;
export const RepoIntegrityCompromisedReason = e.Data.taggedEnum<RepoIntegrityCompromisedReason>();
export class VerifyRepoIntegrityError extends e.Data.TaggedError("VerifyRepoIntegrityError")<{
  reason: RepoIntegrityCompromisedReason;
  repo: RepoIdentifier;
}> {
  public static toToolError({reason, repo}: VerifyRepoIntegrityError): BadArgumentError | BadPreconditionsError {
    return e.pipe(
      reason,
      RepoIntegrityCompromisedReason.$match({
        OrgMissing: () => new BadArgumentError({argument: "org", reason: `There is no org "${repo.org}" in this workspace`}),
        RepoMissing: () => new BadArgumentError({argument: "repo", reason: `There is no repo "${repo.toString()}" in this workspace`}),
        SubmoduleMisconfiguration: () => new BadPreconditionsError({
          cause: `Malformed submodule configuration for repo ${repo.toString()}`,
          fix: `Re-run \`${TOOL_NAME} load ${repo.org} ${repo.repo}\` to re-configure`
        }),
        NotAPackage: () => new BadPreconditionsError({
          cause: `Missing package.json in repo ${repo.toString()}`,
          fix: ""
        })
      })
    )
  }
}
export class NotInWorkspaceError extends e.Data.TaggedError("NotInWorkspaceError")<{
  path: string;
}> {}

export interface RepoLocation {
  readonly absolutePath: string;
  /** Relative to the workspace root, which is where git commands on the workspace's submodules run. */
  readonly relativePath: string;
}

export interface IToolState {
  assertInWorkspace(): EffectGen<{ workspaceRoot: string }, NotInWorkspaceError>;
  // User state
  readCurrentUserState(): EffectGen<e.Option.Option<CurrentUserState>>;
  clearCurrentUserState(): EffectGen<void>;
  setUser(opts: { email: string; username: string; accessToken: TokenState }): EffectGen<CurrentUserState>;

  // Repos
  /** Where a loaded repo is, failing when it is not a configured submodule with a package.json. */
  verifyRepoIntegrity(repo: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError | BadArgumentError>;
  orgPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError>;
  repoPath(repoId: RepoIdentifier): EffectGen<RepoLocation, BadPreconditionsError>;
}
