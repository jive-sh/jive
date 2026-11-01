import * as e from "effect";
import type { EffectGen } from "effective-modules";
import type { BadArgumentError } from "@/errors";
import type { CurrentUserState, RepoIdentifier, TokenState } from "@/modules/tool-state/interface";
import type { AccountKey } from "@/modules/account-key/interface";

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
  sshKeyExists(accessToken: GithubAccessToken, key: AccountKey): EffectGen<{authn: boolean; signing: boolean}>;
  setSshKey(writeToken: GithubWriteToken, key: AccountKey): EffectGen<void>;
  /**
   * Gets all repos which user has access to in a given org. If no access token provided, just returns public orgs
   */
  remoteRepos(org: string, accessToken: e.Option.Option<GithubAccessToken>): EffectGen<string[]>;
  canReadFromRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean>;
  canWriteToRemote(repo: RepoIdentifier, accessToken: GithubAccessToken): EffectGen<boolean>;
  remoteUrls(repo: RepoIdentifier): {ssh: string; https: string;};
}
