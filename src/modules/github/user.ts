import * as e from "effect";
import type { TokenExpirationState } from "@/modules/tool-state/interface";
import type { GithubAccessToken } from "./interface";
import { fetchResponse, githubHeaders, parseJson } from "./shared";
import { decodeGitHubTokenResponse } from "./token-response";

interface GitHubUserProfile {
  readonly login?: string;
  readonly email?: string | null;
}

interface GitHubUserEmail {
  readonly email?: string;
  readonly verified?: boolean;
  readonly primary?: boolean;
}

export interface GitHubSession {
  readonly accessToken: string;
  readonly scope: string;
  readonly username: string;
  readonly email: string;
  readonly expiration: e.Option.Option<TokenExpirationState>;
}

const buildExpiration = (
  accessTokenExpiresIn: number,
  refreshToken: string,
  refreshTokenExpiresIn: number,
): e.Option.Option<TokenExpirationState> => {
  if (!refreshToken || accessTokenExpiresIn <= 0 || refreshTokenExpiresIn <= 0) {
    return e.Option.none();
  }

  const now = Date.now();
  return e.Option.some({
    tokenExpiresAt: now + (accessTokenExpiresIn * 1000),
    refreshToken,
    refreshTokenExpiresAt: now + (refreshTokenExpiresIn * 1000),
  });
};

const fetchVerifiedEmailsFromToken = (accessToken: string): e.Effect.Effect<string[]> =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse("https://api.github.com/user/emails", {
        headers: githubHeaders(accessToken),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return [] as string[];
    }

    const maybeEmails = yield* e.pipe(
      parseJson<GitHubUserEmail[]>(maybeResponse.value),
      e.Effect.map(emails => e.Option.some(emails)),
      e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(e.Option.none<GitHubUserEmail[]>())),
    );
    if (e.Option.isNone(maybeEmails)) {
      return [] as string[];
    }

    return maybeEmails.value
      .filter(email => email.verified && typeof email.email === "string" && email.email.length > 0)
      .sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
      .map(email => email.email!);
  });

const fetchSession = (
  accessToken: string,
  scope: string,
  refreshToken: string,
  accessTokenExpiresIn: number,
  refreshTokenExpiresIn: number,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    const maybeUserResponse = yield* e.pipe(
      fetchResponse("https://api.github.com/user", {
        headers: githubHeaders(accessToken),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeUserResponse) || !maybeUserResponse.value.ok) {
      return e.Option.none<GitHubSession>();
    }

    const maybeProfile = yield* e.pipe(
      parseJson<GitHubUserProfile>(maybeUserResponse.value),
      e.Effect.map(profile => e.Option.some(profile)),
      e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(e.Option.none<GitHubUserProfile>())),
    );
    if (e.Option.isNone(maybeProfile) || !maybeProfile.value.login) {
      return e.Option.none<GitHubSession>();
    }

    const verifiedEmails = yield* fetchVerifiedEmailsFromToken(accessToken);
    const email =
      typeof maybeProfile.value.email === "string" && maybeProfile.value.email.length > 0 ?
        maybeProfile.value.email :
        (verifiedEmails[0] ?? "");

    return e.Option.some({
      accessToken,
      scope,
      username: maybeProfile.value.login,
      email,
      expiration: buildExpiration(accessTokenExpiresIn, refreshToken, refreshTokenExpiresIn),
    });
  });

export const fetchSessionFromTokenResponse = (
  response: Parameters<typeof decodeGitHubTokenResponse>[0],
  fallbackScope: string,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    const maybeTokenResponse = yield* e.pipe(
      decodeGitHubTokenResponse(response),
      e.Effect.map(tokenResponse => e.Option.some(tokenResponse)),
      e.Effect.catchTag("ParseError", () => e.Effect.succeed(e.Option.none())),
    );
    if (e.Option.isNone(maybeTokenResponse) || !maybeTokenResponse.value.access_token) {
      return e.Option.none<GitHubSession>();
    }

    return yield* fetchSession(
      maybeTokenResponse.value.access_token,
      maybeTokenResponse.value.scope ?? fallbackScope,
      maybeTokenResponse.value.refresh_token ?? "",
      maybeTokenResponse.value.expires_in ?? 0,
      maybeTokenResponse.value.refresh_token_expires_in ?? 0,
    );
  });

export const getVerifiedEmails = (accessToken: GithubAccessToken): e.Effect.Effect<string[]> =>
  fetchVerifiedEmailsFromToken(accessToken.accessToken);
