import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError } from "@/errors";
import type { CurrentUserState, RepoIdentifier, TokenState } from "@/modules/tool-state/interface";
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

export interface IGitHub {
  // TODO: in implementation test if token is expired using a dummy request.
  //       this should handle token refresh (if necessary) and save the updated token state
  resolveAccessToken(userState: CurrentUserState): EffectGen<{accessToken: GithubAccessToken}, BadArgumentError>;
  oauthLogin(username?: string): EffectGen<{accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string;}>;
  getVerifiedEmails(accessToken: GithubAccessToken): EffectGen<string[]>;
  sshKeyExists(accessToken: GithubAccessToken, key: SshKey): EffectGen<{authn: boolean; signing: boolean}>;
  setSshKey(writeToken: GithubWriteToken, key: SshKey): EffectGen<void>;
  /**
   * Gets all repos which user has access to in a given org. If no access token provided, just returns public orgs
   */
  remoteRepos(org: string, accessToken: e.Option.Option<GithubAccessToken>): EffectGen<string[]>;
  canReadFromRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean>;
  canWriteToRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean>;
  remoteUrls(repo: RepoIdentifier): {ssh: string; https: string;};
  /**
   * For all orgs which you're an owner of, attempts to
   * 1. Install Github app which will automate dependency management and enforce verified commits only
   * 2. Coordinate npm org setup via the npm module
   */
  setupOrgs(writeToken: GithubWriteToken): EffectGen<void>;
  /**
   * Creates repo in github, sets deployment secrets, publishes initial implementation, installs the GH App,
   * and coordinates npm trusted publishing via the npm module
   */
  setupRemoteRepo(repo: RepoIdentifier, writeToken: GithubWriteToken, cicdSecrets: Record<string, string>): EffectGen<void>;
}
