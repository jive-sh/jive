import * as e from "effect";
import type { GithubAccessTokenType } from "@/modules/github/interface";
import type { SshKey } from "@/modules/ssh/interface";
import { BadArgumentError, BadPreconditionsError } from "@/modules";
import { TOOL_NAME } from "@/constants";
import { RepoIdentifier } from "./repo-identifier";
export { RepoIdentifier } from "./repo-identifier";

export interface CurrentUserState {
  readonly username: string;
  readonly email: string;
  readonly accessTokenState: TokenState;
  readonly sshKey: e.Option.Option<SshKey>;
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
  public static toToolError({reason, repo}: VerifyRepoIntegrityError): e.Effect.Effect<never, BadArgumentError | BadPreconditionsError> {
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

export class IToolState extends e.Context.Tag("IToolState")<IToolState, {
  readonly assertInWorkspace: e.Effect.Effect<{workspaceRoot: string}, NotInWorkspaceError>;
  /**
   * Tool state will create a temporary directory for another tool to operate out of.
   */
  readonly usingTempDirectory: <T, E> (doThing: (tempPath: string) => e.Effect.Effect<T, E>) => e.Effect.Effect<T, E>;
  
  // User state
  readonly readCurrentUserState: e.Effect.Effect<e.Option.Option<CurrentUserState>>;
  readonly clearCurrentUserState: e.Effect.Effect<void>;
  /**
   * Should clear out ssh key associated with user
   */
  readonly setUser: (opts: {email: string; username: string; accessToken: TokenState}) => e.Effect.Effect<CurrentUserState>;
  // Moves the ssh key to the current user location (amongst other things)
  readonly setSshKey: (sshKey: SshKey) => e.Effect.Effect<{ newUserState: CurrentUserState }>;
  
  // Repos
  readonly verifyRepoIntegrity: (repo: RepoIdentifier) => e.Effect.Effect<{absolutePath: string; relativePath: string;}, BadPreconditionsError | BadArgumentError>;
}>() {}
