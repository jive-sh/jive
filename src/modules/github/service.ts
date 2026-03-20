import * as e from "effect";
import { TOOL_NAME } from "@/constants";
import type { SshKey } from "@/modules/ssh/interface";
import type { RepoIdentifier, TokenExpirationState, TokenState } from "@/modules/tool-state/interface";
import {
  GithubAccessTokenType,
  UnableToRefreshAccessTokenError,
  type GithubAccessToken,
  type GithubWriteToken,
} from "./interface";
import { beginOAuthCodeRequest, displayOAuthBrowserAction, type OAuthBrowserHost, type OAuthCodeResult } from "./oauth";

const CLIENT_ID = "Ov23liKYxk1Ag7SsNhbP";
const CLIENT_SECRET = "e2901fbe93c591e7a53a903e70490ff87e998159";
const GITHUB_KEY_PREFIX = `${TOOL_NAME}:`;
const READ_SCOPES = "repo user read:org read:public_key read:ssh_signing_key";
const WRITE_SCOPES = `${READ_SCOPES} write:public_key write:ssh_signing_key admin:ssh_signing_key`;

class GitHubRequestError extends e.Data.TaggedError("GitHubRequestError")<{
  message: string;
}> {}

class GitHubJsonParseError extends e.Data.TaggedError("GitHubJsonParseError")<{
  message: string;
}> {}

interface GitHubTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number | string;
  readonly refresh_token_expires_in?: number | string;
  readonly error?: string;
  readonly error_description?: string;
}

interface GitHubUserProfile {
  readonly login?: string;
  readonly email?: string | null;
}

interface GitHubUserEmail {
  readonly email?: string;
  readonly verified?: boolean;
  readonly primary?: boolean;
}

interface GitHubUserKey {
  readonly id: number;
  readonly key: string;
  readonly title: string;
}

interface GitHubSession {
  readonly accessToken: string;
  readonly scope: string;
  readonly username: string;
  readonly email: string;
  readonly expiration: e.Option.Option<TokenExpirationState>;
}

const fetchResponse = (input: string | URL, init?: RequestInit) =>
  e.Effect.tryPromise({
    try: () => fetch(input, init),
    catch: error => new GitHubRequestError({ message: getErrorMessage(error) }),
  });

const parseJson = <A>(response: Response) =>
  e.Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: error => new GitHubJsonParseError({ message: getErrorMessage(error) }),
  });

const readResponseMessage = (response: Response) =>
  e.pipe(
    parseJson<{ message?: string }>(response),
    e.Effect.map(body => body.message ?? String(response.status)),
    e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(String(response.status))),
  );

const parsePositiveInteger = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 0;
};

const buildAuthorizeUrl = (
  scopes: string,
  redirectUri: string,
  state: string,
  promptAccountSelection: boolean,
): URL => {
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("state", state);
  if (promptAccountSelection) {
    authorizeUrl.searchParams.set("prompt", "select_account");
  }
  return authorizeUrl;
};

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

const normalizeKeyBody = (publicKey: string): string => {
  const [keyType = "", keyBody = ""] = publicKey.trim().split(/\s+/, 3);
  return keyType && keyBody ? `${keyType} ${keyBody}` : publicKey.trim();
};

const managedKeyTitle = (key: SshKey): string =>
  `${GITHUB_KEY_PREFIX}${key.email}:${key.name}`;

const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
});

const fetchVerifiedEmailsFromToken = (token: string): e.Effect.Effect<string[]> =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse("https://api.github.com/user/emails", {
        headers: githubHeaders(token),
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
) : e.Effect.Effect<e.Option.Option<GitHubSession>> =>
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

const exchangeCodeForSession = (auth: OAuthCodeResult, scopes: string): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    const maybeTokenResponse = yield* e.pipe(
      fetchResponse("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: auth.code,
          redirect_uri: auth.redirectUri,
        }),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", error =>
        e.Effect.gen(function*() {
          yield* e.Effect.logError(`GitHub OAuth token exchange failed: ${error.message}`);
          return e.Option.none<Response>();
        }),
      ),
    );
    if (e.Option.isNone(maybeTokenResponse)) {
      return e.Option.none<GitHubSession>();
    }
    if (!maybeTokenResponse.value.ok) {
      const message = yield* readResponseMessage(maybeTokenResponse.value);
      yield* e.Effect.logError(`GitHub OAuth token exchange failed: ${message}`);
      return e.Option.none<GitHubSession>();
    }

    const maybeTokenPayload = yield* e.pipe(
      parseJson<GitHubTokenResponse>(maybeTokenResponse.value),
      e.Effect.map(payload => e.Option.some(payload)),
      e.Effect.catchTag("GitHubJsonParseError", error =>
        e.Effect.gen(function*() {
          yield* e.Effect.logError(`GitHub OAuth token response was invalid JSON: ${error.message}`);
          return e.Option.none<GitHubTokenResponse>();
        }),
      ),
    );
    if (e.Option.isNone(maybeTokenPayload)) {
      return e.Option.none<GitHubSession>();
    }
    if (maybeTokenPayload.value.error || !maybeTokenPayload.value.access_token) {
      yield* e.Effect.logError(
        maybeTokenPayload.value.error_description ?? maybeTokenPayload.value.error ?? "GitHub OAuth did not return an access token.",
      );
      return e.Option.none<GitHubSession>();
    }

    return yield* fetchSession(
      maybeTokenPayload.value.access_token,
      maybeTokenPayload.value.scope ?? scopes,
      maybeTokenPayload.value.refresh_token ?? "",
      parsePositiveInteger(maybeTokenPayload.value.expires_in),
      parsePositiveInteger(maybeTokenPayload.value.refresh_token_expires_in),
    );
  });

const loginForScopes = (
  hostShell: OAuthBrowserHost,
  scopes: string,
  browserLabel: string,
  expectedUsername?: string,
): e.Effect.Effect<GitHubSession> =>
  e.Effect.gen(function*() {
    const request = beginOAuthCodeRequest(
      hostShell,
      browserLabel,
      (redirectUri, state) => buildAuthorizeUrl(scopes, redirectUri, state, !expectedUsername),
      { openBrowser: true },
    );
    const maybeCode = yield* request.waitForCode;
    if (e.Option.isNone(maybeCode)) {
      request.continueInBrowser(displayOAuthBrowserAction(`${browserLabel} failed`, "You may close this tab."));
      return yield* e.Effect.dieMessage(`${browserLabel} did not complete successfully.`);
    }

    const maybeSession = yield* exchangeCodeForSession(maybeCode.value, scopes);
    if (e.Option.isNone(maybeSession)) {
      request.continueInBrowser(displayOAuthBrowserAction(`${browserLabel} failed`, "You may close this tab."));
      return yield* e.Effect.dieMessage(`${browserLabel} did not return a usable GitHub session.`);
    }
    if (expectedUsername && maybeSession.value.username !== expectedUsername) {
      request.continueInBrowser(displayOAuthBrowserAction(`${browserLabel} failed`, "You may close this tab."));
      return yield* e.Effect.dieMessage(
        `Expected GitHub user ${expectedUsername} but got ${maybeSession.value.username}.`,
      );
    }

    request.continueInBrowser(displayOAuthBrowserAction(`${browserLabel} complete`, "You may close this tab."));
    return maybeSession.value;
  });

const refreshAccessToken = (
  refreshToken: string,
  requestedScope: string,
): e.Effect.Effect<e.Option.Option<{ accessToken: string; scope: string }>> =>
  e.Effect.gen(function*() {
    const payload = new URLSearchParams();
    payload.set("client_id", CLIENT_ID);
    payload.set("client_secret", CLIENT_SECRET);
    payload.set("grant_type", "refresh_token");
    payload.set("refresh_token", refreshToken);
    if (requestedScope) {
      payload.set("scope", requestedScope);
    }

    const maybeResponse = yield* e.pipe(
      fetchResponse("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload.toString(),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return e.Option.none<{ accessToken: string; scope: string }>();
    }

    const maybePayload = yield* e.pipe(
      parseJson<GitHubTokenResponse>(maybeResponse.value),
      e.Effect.map(payload => e.Option.some(payload)),
      e.Effect.catchTag("GitHubJsonParseError", () => e.Effect.succeed(e.Option.none<GitHubTokenResponse>())),
    );
    if (
      e.Option.isNone(maybePayload) ||
      maybePayload.value.error ||
      !maybePayload.value.access_token
    ) {
      return e.Option.none<{ accessToken: string; scope: string }>();
    }

    return e.Option.some({
      accessToken: maybePayload.value.access_token,
      scope: maybePayload.value.scope ?? requestedScope,
    });
  });

const fetchUserKeys = (token: string, endpoint: string): e.Effect.Effect<GitHubUserKey[]> =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse(endpoint, {
        headers: githubHeaders(token),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(maybeResponse) || !maybeResponse.value.ok) {
      return [] as GitHubUserKey[];
    }

    const maybeRows = yield* e.pipe(
      parseJson<Array<{ id: number; key?: string; title?: string }>>(maybeResponse.value),
      e.Effect.map(rows => e.Option.some(rows)),
      e.Effect.catchTag(
        "GitHubJsonParseError",
        () => e.Effect.succeed(e.Option.none<Array<{ id: number; key?: string; title?: string }>>()),
      ),
    );
    if (e.Option.isNone(maybeRows)) {
      return [] as GitHubUserKey[];
    }

    return maybeRows.value
      .filter(row => typeof row.id === "number" && typeof row.key === "string")
      .map(row => ({
        id: row.id,
        key: row.key!,
        title: row.title ?? "",
      }));
  });

const deleteUserKey = (token: string, endpoint: string) =>
  e.pipe(
    fetchResponse(endpoint, {
      method: "DELETE",
      headers: githubHeaders(token),
    }),
    e.Effect.flatMap(response =>
      response.ok ?
        e.Effect.void :
        e.Effect.logWarning(`GitHub key deletion failed with status ${response.status}.`),
    ),
    e.Effect.catchTag("GitHubRequestError", error => e.Effect.logWarning(`GitHub key deletion failed: ${error.message}`)),
  );

const createUserKey = (token: string, endpoint: string, title: string, publicKey: string) =>
  e.Effect.gen(function*() {
    const maybeResponse = yield* e.pipe(
      fetchResponse(endpoint, {
        method: "POST",
        headers: {
          ...githubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          key: publicKey,
        }),
      }),
      e.Effect.map(response => e.Option.some(response)),
      e.Effect.catchTag("GitHubRequestError", error =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(`GitHub key creation failed: ${error.message}`);
          return e.Option.none<Response>();
        }),
      ),
    );
    if (e.Option.isNone(maybeResponse)) {
      return;
    }
    if (maybeResponse.value.ok) {
      return;
    }
    const message = yield* readResponseMessage(maybeResponse.value);
    yield* e.Effect.logWarning(`GitHub key creation failed: ${message}`);
  });

const ensureUserKey = (
  token: string,
  publicKey: string,
  title: string,
  listEndpoint: string,
  deleteEndpointBase: string,
) =>
  e.Effect.gen(function*() {
    const existingKeys = yield* fetchUserKeys(token, listEndpoint);
    const normalizedPublicKey = normalizeKeyBody(publicKey);
    if (existingKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey)) {
      return;
    }

    for (const existingKey of existingKeys.filter(existingKey => existingKey.title === title)) {
      yield* deleteUserKey(token, `${deleteEndpointBase}/${existingKey.id}`);
    }

    yield* createUserKey(token, listEndpoint, title, publicKey);
  });

export const resolveAccessToken = (tokenState: TokenState) =>
  e.Effect.gen(function*() {
    if (e.Option.isNone(tokenState.expiration)) {
      return {
        accessToken: {
          accessToken: tokenState.token,
          tokenType: tokenState.tokenType,
        },
      };
    }

    if (Date.now() < tokenState.expiration.value.tokenExpiresAt) {
      return {
        accessToken: {
          accessToken: tokenState.token,
          tokenType: tokenState.tokenType,
        },
      };
    }

    if (Date.now() >= tokenState.expiration.value.refreshTokenExpiresAt) {
      return yield* new UnableToRefreshAccessTokenError({ expired: true });
    }

    const maybeRefreshedToken = yield* refreshAccessToken(
      tokenState.expiration.value.refreshToken,
      tokenState.scope,
    );
    if (e.Option.isNone(maybeRefreshedToken)) {
      return yield* new UnableToRefreshAccessTokenError({ expired: false });
    }

    return {
      accessToken: {
        accessToken: maybeRefreshedToken.value.accessToken,
        tokenType: tokenState.tokenType,
      },
    };
  });

export const oauthLogin = (
  hostShell: OAuthBrowserHost,
  username?: string,
): e.Effect.Effect<{ accessTokenState: TokenState; writeToken: GithubWriteToken; username: string; email: string }> =>
  e.Effect.gen(function*() {
    const writeSession = yield* loginForScopes(hostShell, WRITE_SCOPES, "GitHub write authorization", username);
    const readSession = yield* loginForScopes(hostShell, READ_SCOPES, "GitHub read authorization", writeSession.username);
    const email = readSession.email || writeSession.email;
    if (!email) {
      return yield* e.Effect.dieMessage("GitHub login completed without a usable verified email.");
    }

    return {
      accessTokenState: {
        tokenType: GithubAccessTokenType.OAuthApp(),
        token: readSession.accessToken,
        scope: readSession.scope,
        expiration: readSession.expiration,
      },
      writeToken: {
        writeToken: writeSession.accessToken,
      },
      username: readSession.username,
      email,
    };
  });

export const getVerifiedEmails = (accessToken: GithubAccessToken): e.Effect.Effect<string[]> =>
  fetchVerifiedEmailsFromToken(accessToken.accessToken);

export const sshKeyExists = (
  accessToken: GithubAccessToken,
  key: SshKey,
): e.Effect.Effect<{ authn: boolean; signing: boolean }> =>
  e.Effect.gen(function*() {
    const normalizedPublicKey = normalizeKeyBody(key.pubkey);
    const authKeys = yield* fetchUserKeys(accessToken.accessToken, "https://api.github.com/user/keys");
    const signingKeys = yield* fetchUserKeys(accessToken.accessToken, "https://api.github.com/user/ssh_signing_keys");
    return {
      authn: authKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey),
      signing: signingKeys.some(existingKey => normalizeKeyBody(existingKey.key) === normalizedPublicKey),
    };
  });

export const setSshKey = (writeToken: GithubWriteToken, key: SshKey): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const title = managedKeyTitle(key);
    yield* ensureUserKey(
      writeToken.writeToken,
      key.pubkey,
      title,
      "https://api.github.com/user/keys",
      "https://api.github.com/user/keys",
    );
    yield* ensureUserKey(
      writeToken.writeToken,
      key.pubkey,
      title,
      "https://api.github.com/user/ssh_signing_keys",
      "https://api.github.com/user/ssh_signing_keys",
    );
  });

export const remoteRepos = (
  org: string,
  accessToken: e.Option.Option<GithubAccessToken>,
): e.Effect.Effect<string[]> => {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (e.Option.isSome(accessToken)) {
    headers.Authorization = `Bearer ${accessToken.value.accessToken}`;
  }

  const fetchRepoNames = (endpoint: string) =>
    e.pipe(
      fetchResponse(endpoint, { headers }),
      e.Effect.flatMap(response => {
        if (!response.ok) {
          return e.Effect.succeed(e.Option.none<string[]>());
        }
        return e.pipe(
          parseJson<Array<{ name?: string }>>(response),
          e.Effect.map(rows =>
            e.Option.some(
              rows
                .map(row => row.name)
                .filter((name): name is string => typeof name === "string" && name.length > 0),
            ),
          ),
        );
      }),
      e.Effect.catchTag("GitHubRequestError", "GitHubJsonParseError", () => e.Effect.succeed(e.Option.none<string[]>())),
    );

  return e.Effect.gen(function*() {
    const orgRepos = yield* fetchRepoNames(`https://api.github.com/orgs/${org}/repos?per_page=100&type=all`);
    if (e.Option.isSome(orgRepos)) {
      return orgRepos.value;
    }
    const userRepos = yield* fetchRepoNames(`https://api.github.com/users/${org}/repos?per_page=100&type=all`);
    return e.Option.getOrElse(userRepos, () => [] as string[]);
  });
};

export const canReadFromRemote = (
  repo: RepoIdentifier,
  accessToken: GithubAccessToken,
): e.Effect.Effect<boolean> =>
  e.pipe(
    fetchResponse(`https://api.github.com/repos/${repo.org}/${repo.repo}`, {
      headers: githubHeaders(accessToken.accessToken),
    }),
    e.Effect.map(response => response.ok),
    e.Effect.catchTag("GitHubRequestError", () => e.Effect.succeed(false)),
  );

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
