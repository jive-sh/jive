import * as e from "effect";
import type { RepoIdentifier, TokenState } from "@/modules/tool-state/interface";
import type { SshKey } from "@/modules/ssh/interface";

export type GithubAccessToken = {
  readonly accessToken: string;
  readonly tokenType: GithubAccessTokenType;
}

export type GithubWriteToken = {
  readonly writeToken: string;
}

export type GithubAccessTokenType = e.Data.TaggedEnum<{
  OAuthApp: {};
  GithubApp: {};
}>;
export const GithubAccessTokenType = e.Data.taggedEnum<GithubAccessTokenType>();

export class UnableToRefreshAccessTokenError extends e.Data.TaggedError("UnableToRefreshAccessTokenError")<{
  expired: boolean;
}> {}

export class IGitHub extends e.Context.Tag("IGitHub")<IGitHub, {
  // TODO: in implementation test if token is expired using a dummy request.
  //       this should handle token refresh (if necessary) and save the updated token state
  readonly resolveAccessToken: (tokenState: TokenState) => e.Effect.Effect<{accessToken: GithubAccessToken}, UnableToRefreshAccessTokenError>;
  readonly oauthLogin: (username?: string) => e.Effect.Effect<{accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string;}>;
  readonly getVerifiedEmails: (accessToken: GithubAccessToken) => e.Effect.Effect<string[]>;
  readonly sshKeyExists: (accessToken: GithubAccessToken, key: SshKey) => e.Effect.Effect<{authn: boolean; signing: boolean}>;
  readonly setSshKey: (writeToken: GithubWriteToken, key: SshKey) => e.Effect.Effect<void>;
  /**
   * For all orgs which you're an owner of, attempts to
   * 1. Install Github app which will automate dependency management and enforce verified commits only
   * 2. Coordinate npm org setup via the npm module
   */
  readonly setupOrgs: (writeToken: GithubWriteToken) => e.Effect.Effect<void>;
  /**
   * Gets all repos which user has access to in a given org. If no access token provided, just returns public orgs
   */
  readonly remoteRepos: (org: string, accessToken: e.Option.Option<GithubAccessToken>) => e.Effect.Effect<string[]>;
  readonly canReadFromRemote: (repo: RepoIdentifier, accessToken: GithubAccessToken) => e.Effect.Effect<boolean>;
  readonly canWriteToRemote: (repo: RepoIdentifier, accessToken: GithubAccessToken) => e.Effect.Effect<boolean>;
  /**
   * Creates repo in github, sets deployment secrets, publishes initial implementation, installs the GH App,
   * and coordinates npm trusted publishing via the npm module
   */
  readonly setupRepo: (repo: RepoIdentifier, writeToken: GithubWriteToken, cicdSecrets: Record<string, string>) => e.Effect.Effect<void>;
}>() {}
