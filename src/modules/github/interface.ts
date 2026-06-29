import * as e from "effect";
import type { CurrentUserState, RepoIdentifier, TokenState } from "@/modules/tool-state/interface";
import type { SshKey } from "@/modules/ssh/interface";
import { BadArgumentError, BadPreconditionsError, Module, modules } from "..";
import type { GenEffect } from "@/temp-libs/effective-modules";

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

export interface IGitHub {
  // TODO: in implementation test if token is expired using a dummy request.
  //       this should handle token refresh (if necessary) and save the updated token state
  resolveAccessToken(userState: CurrentUserState): GenEffect<{accessToken: GithubAccessToken}, BadArgumentError>;
  oauthLogin(username?: string): GenEffect<{accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string;}>;
  getVerifiedEmails(accessToken: GithubAccessToken): GenEffect<string[]>;
  sshKeyExists(accessToken: GithubAccessToken, key: SshKey): GenEffect<{authn: boolean; signing: boolean}>;
  setSshKey(writeToken: GithubWriteToken, key: SshKey): GenEffect<void>;
  /**
   * Gets all repos which user has access to in a given org. If no access token provided, just returns public orgs
   */
  remoteRepos(org: string, accessToken: e.Option.Option<GithubAccessToken>): GenEffect<string[]>;
  canReadFromRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): GenEffect<boolean>;
  canWriteToRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): GenEffect<boolean>;
  remoteUrls(repo: RepoIdentifier): {ssh: string; https: string;};
  /**
   * For all orgs which you're an owner of, attempts to
   * 1. Install Github app which will automate dependency management and enforce verified commits only
   * 2. Coordinate npm org setup via the npm module
   */
  setupOrgs(writeToken: GithubWriteToken): GenEffect<void>;
  /**
   * Creates repo in github, sets deployment secrets, publishes initial implementation, installs the GH App,
   * and coordinates npm trusted publishing via the npm module
   */
  setupRemoteRepo(repo: RepoIdentifier, writeToken: GithubWriteToken, cicdSecrets: Record<string, string>): GenEffect<void>;
}
