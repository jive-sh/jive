import * as e from "effect";
import { GITHUB_KEY_PREFIX } from "../auth/constants";
import { beginOAuthCodeRequest, displayOAuthBrowserAction, type OAuthBrowserHost, type OAuthBrowserAction, type OAuthCodeResult } from "../auth/oauth";
import { parsePublicKey } from "../ssh/key-format";
import type { GitHubJiveKeyInventory, GitHubSession, GitHubUserKey } from "./types";

const CLIENT_ID = "Ov23liKYxk1Ag7SsNhbP";
const CLIENT_SECRET = "e2901fbe93c591e7a53a903e70490ff87e998159";

// repo                  list/read private repos (and currently broader repo permissions for OAuth apps)
// user                  read profile + primary email
// read:org              list org membership
// read:public_key       list auth SSH keys
// read:ssh_signing_key  list SSH signing keys
const READ_SCOPES = "repo user read:org read:public_key read:ssh_signing_key";

// write:public_key      register SSH authentication keys (/user/keys)
// write:ssh_signing_key create SSH signing keys (/user/ssh_signing_keys)
// admin:ssh_signing_key delete SSH signing keys (/user/ssh_signing_keys/:id)
const WRITE_SCOPES = `${READ_SCOPES} write:public_key write:ssh_signing_key admin:ssh_signing_key`;
const WRITE_KEY_SCOPES = ["write:public_key", "write:ssh_signing_key", "admin:ssh_signing_key"] as const;
const REQUIRED_READ_SCOPES = ["repo", "user", "read:org", "read:public_key", "read:ssh_signing_key"] as const;

interface GitHubUserEmail {
  email: string;
  verified: boolean;
}

interface TokenExchangeResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface WorkspaceGitApi {
  readonly localOrgs: e.Effect.Effect<string[]>;
  readonly localRepos: (org: string) => e.Effect.Effect<string[]>;
}

export interface PendingGitHubLogin {
  readonly authorizeUrl: URL;
  readonly waitForSession: e.Effect.Effect<e.Option.Option<GitHubSession>>;
  readonly continueInBrowser: (action: OAuthBrowserAction) => void;
}

interface GitHubLoginOptions {
  readonly openBrowser?: boolean;
  readonly promptAccountSelection?: boolean;
}

export function isGitHubOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export function beginGitHubReadOnlyLogin(
  hostShell: OAuthBrowserHost,
  options: GitHubLoginOptions = {},
): PendingGitHubLogin {
  return beginGitHubLoginWithScopes(hostShell, READ_SCOPES, "GitHub (read token)", {
    openBrowser: options.openBrowser ?? true,
    promptAccountSelection: options.promptAccountSelection ?? false,
  });
}

export function beginGitHubWriteLogin(
  hostShell: OAuthBrowserHost,
  options: GitHubLoginOptions = {},
): PendingGitHubLogin {
  return beginGitHubLoginWithScopes(hostShell, WRITE_SCOPES, "GitHub (write token)", {
    openBrowser: options.openBrowser ?? true,
    promptAccountSelection: options.promptAccountSelection ?? false,
  });
}

export const renewWriteTokenFromRefresh = (
  refreshToken: string,
): e.Effect.Effect<e.Option.Option<GitHubSession>> => renewTokenFromRefresh(refreshToken, WRITE_SCOPES);

export function isWriteCapableScope(scopeList: string): boolean {
  return WRITE_KEY_SCOPES.every((scope) => hasScope(scopeList, scope));
}

export function isReadScopeSatisfied(scopeList: string): boolean {
  return REQUIRED_READ_SCOPES.every((scope) => hasScope(scopeList, scope));
}

const renewTokenFromRefresh = (
  refreshToken: string,
  fallbackScope: string,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    if (!refreshToken) return e.Option.none();

    const downscoped = yield* exchangeRefreshToken(refreshToken, fallbackScope);
    if (e.Option.isSome(downscoped)) return downscoped;

    return yield* exchangeRefreshToken(refreshToken, "");
  });

const exchangeRefreshToken = (
  refreshToken: string,
  requestedScope: string,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    if (!refreshToken) return e.Option.none();

    const payload = new URLSearchParams();
    payload.set("client_id", CLIENT_ID);
    payload.set("client_secret", CLIENT_SECRET);
    payload.set("grant_type", "refresh_token");
    payload.set("refresh_token", refreshToken);
    if (requestedScope) payload.set("scope", requestedScope);

    const tokenRes = yield* fetchResponse("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(tokenRes) || !tokenRes.value.ok) return e.Option.none();

    const tokenData = yield* parseJson<TokenExchangeResponse>(tokenRes.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed({} as TokenExchangeResponse)),
    );
    if (tokenData.error || !tokenData.access_token) return e.Option.none();

    return yield* fetchGitHubSession(
      tokenData.access_token,
      tokenData.scope ?? requestedScope,
      tokenData.token_type ?? "bearer",
      tokenData.refresh_token ?? "",
      parsePositiveInteger(tokenData.refresh_token_expires_in),
    );
  });

export const getVerifiedGitHubEmails = (githubToken: string): e.Effect.Effect<string[]> =>
  fetchResponse("https://api.github.com/user/emails", {
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  }).pipe(
    e.Effect.flatMap((response) => {
      if (!response.ok) return e.Effect.succeed([] as string[]);

      return parseJson<GitHubUserEmail[]>(response).pipe(
        e.Effect.map((emails) =>
          emails
            .filter((entry) => entry.verified)
            .map((entry) => entry.email)
            .filter(Boolean)
        ),
      );
    }),
    e.Effect.catchAll(() => e.Effect.succeed([])),
  );

export const listGitHubJiveKeys = (
  githubToken: string,
): e.Effect.Effect<e.Option.Option<GitHubJiveKeyInventory>> =>
  e.Effect.gen(function*() {
    const all = yield* fetchAllGitHubKeys(githubToken);
    if (e.Option.isNone(all)) return e.Option.none();

    return e.Option.some({
      auth: all.value.auth.filter(isJiveGitHubKey),
      signing: all.value.signing.filter(isJiveGitHubKey),
    });
  });

export const ensureGitHubAuthKey = (
  githubToken: string,
  keyName: string,
  publicKey: string,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory> = e.Option.none(),
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const parsed = parsePublicKey(publicKey);
    if (e.Option.isNone(parsed)) {
      yield* e.Effect.logWarning("Auth key was not parseable; skipping GitHub auth key update.");
      return;
    }

    const inventory = yield* resolveJiveInventory(githubToken, knownJiveInventory);
    if (e.Option.isNone(inventory)) {
      yield* e.Effect.logWarning("Could not verify existing GitHub auth keys before registering the jive key.");
      return;
    }

    yield* replaceAuthKeyByName(githubToken, keyName, publicKey, parsed.value.keyBody, inventory.value.auth);
  });

export const ensureGitHubSigningKey = (
  githubToken: string,
  keyName: string,
  publicKey: string,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory> = e.Option.none(),
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const inventory = yield* resolveJiveInventory(githubToken, knownJiveInventory);
    if (e.Option.isNone(inventory)) {
      yield* e.Effect.logWarning("Could not verify existing GitHub SSH signing keys before registering the jive key.");
      return;
    }

    yield* replaceSigningKeyByName(githubToken, keyName, publicKey, inventory.value.signing);
  });

export const checkWorkspaceRepoAccess = (
  root: string,
  githubToken: string,
  git: WorkspaceGitApi,
): e.Effect.Effect<void> =>
  forEachWorkspaceRepo(root, git, (org, repo) => checkRepoAccess(org, repo, githubToken));

export const remoteRepos = (
  org: string,
  readOnlyToken = "",
): e.Effect.Effect<string[]> =>
  e.Effect.gen(function*() {
    const baseHeaders: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (readOnlyToken) {
      baseHeaders.Authorization = `Bearer ${readOnlyToken}`;
    }

    const orgResponse = yield* fetchResponse(`https://api.github.com/orgs/${org}/repos?per_page=100&type=all`, {
      headers: baseHeaders,
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );

    if (e.Option.isSome(orgResponse) && orgResponse.value.ok) {
      const repos = yield* parseJson<Array<{ name: string }>>(orgResponse.value).pipe(
        e.Effect.catchAll(() => e.Effect.succeed([])),
      );
      return repos.map((repo) => repo.name);
    }

    const userResponse = yield* fetchResponse(`https://api.github.com/users/${org}/repos?per_page=100&type=all`, {
      headers: baseHeaders,
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(userResponse) || !userResponse.value.ok) return [] as string[];

    const repos = yield* parseJson<Array<{ name: string }>>(userResponse.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed([])),
    );
    return repos.map((repo) => repo.name);
  });

export const repoDefaultBranch = (
  org: string,
  repo: string,
  readOnlyToken: string,
): e.Effect.Effect<e.Option.Option<string>> =>
  e.Effect.gen(function*() {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (readOnlyToken) {
      headers.Authorization = `Bearer ${readOnlyToken}`;
    }

    const response = yield* fetchResponse(`https://api.github.com/repos/${org}/${repo}`, { headers }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(response) || !response.value.ok) return e.Option.none<string>();

    const payload = yield* parseJson<{ default_branch?: unknown }>(response.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed({} as { default_branch?: unknown })),
    );
    return typeof payload.default_branch === "string" && payload.default_branch
      ? e.Option.some(payload.default_branch)
      : e.Option.none<string>();
  });

function beginGitHubLoginWithScopes(
  hostShell: OAuthBrowserHost,
  scopes: string,
  providerName: string,
  options: Required<GitHubLoginOptions>,
): PendingGitHubLogin {
  const request = beginOAuthCodeRequest(
    hostShell,
    providerName,
    (redirectUri, state) => buildGitHubAuthorizeUrl(scopes, redirectUri, state, options),
    { openBrowser: options.openBrowser },
  );

  const waitForSession = e.Effect.gen(function*() {
    const auth = yield* request.waitForCode;
    if (e.Option.isNone(auth)) return e.Option.none<GitHubSession>();

    const session = yield* exchangeCodeForSession(auth.value, scopes);
    if (e.Option.isNone(session)) {
      request.continueInBrowser(displayOAuthBrowserAction(
        `${providerName} authorization failed`,
        "You may close this tab.",
      ));
    }
    return session;
  });

  return {
    authorizeUrl: request.authorizeUrl,
    waitForSession,
    continueInBrowser: request.continueInBrowser,
  };
}

const exchangeCodeForSession = (
  auth: OAuthCodeResult,
  scopes: string,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    const tokenRes = yield* fetchResponse("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: auth.code,
        redirect_uri: auth.redirectUri,
      }),
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );

    if (e.Option.isNone(tokenRes) || !tokenRes.value.ok) {
      yield* e.Effect.logError("Failed to exchange the GitHub OAuth code for a token.");
      return e.Option.none();
    }

    const tokenData = yield* parseJson<TokenExchangeResponse>(tokenRes.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed({} as TokenExchangeResponse)),
    );
    if (tokenData.error) {
      yield* e.Effect.logError(`GitHub auth failed: ${tokenData.error_description ?? tokenData.error}`);
      return e.Option.none();
    }

    const token = tokenData.access_token;
    if (!token) {
      yield* e.Effect.logError("No GitHub access token received.");
      return e.Option.none();
    }

    return yield* fetchGitHubSession(
      token,
      tokenData.scope ?? scopes,
      tokenData.token_type ?? "bearer",
      tokenData.refresh_token ?? "",
      parsePositiveInteger(tokenData.refresh_token_expires_in),
    );
  });

function buildGitHubAuthorizeUrl(
  scopes: string,
  redirectUri: string,
  state: string,
  options: Pick<Required<GitHubLoginOptions>, "promptAccountSelection">,
): URL {
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes);
  authUrl.searchParams.set("state", state);
  if (options.promptAccountSelection) {
    authUrl.searchParams.set("prompt", "select_account");
  }
  return authUrl;
}

const replaceAuthKeyByName = (
  githubToken: string,
  keyName: string,
  publicKey: string,
  keyBody: string,
  existingAuth: GitHubUserKey[],
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const sameName = existingAuth.filter((entry) => entry.title === keyName);
    for (const staleKey of sameName) {
      yield* deleteGitHubAuthKey(githubToken, staleKey.id);
    }

    const bodyMatch = existingAuth.find((entry) => normalizeKeyBody(entry.key) === keyBody && entry.title !== keyName);
    if (bodyMatch) {
      yield* e.Effect.logWarning(`Auth key body already exists on GitHub with non-standard title "${bodyMatch.title}".`);
      return;
    }

    yield* createGitHubAuthKey(githubToken, keyName, publicKey);
  });

const replaceSigningKeyByName = (
  githubToken: string,
  keyName: string,
  publicKey: string,
  existingSigning: GitHubUserKey[],
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const sameName = existingSigning.filter((entry) => entry.title === keyName);
    const normalizedKey = normalizeKeyBody(publicKey);
    const exactMatch = sameName.find((entry) => normalizeKeyBody(entry.key) === normalizedKey);
    if (exactMatch) return;

    for (const staleKey of sameName) {
      yield* deleteGitHubSigningKey(githubToken, staleKey.id);
    }

    yield* createGitHubSigningKey(githubToken, keyName, publicKey);
  });

const createGitHubAuthKey = (
  githubToken: string,
  name: string,
  publicKey: string,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log(`Creating key on GitHub (auth): ${name}`);

    const addRes = yield* fetchResponse("https://api.github.com/user/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: publicKey, title: name }),
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll((error) =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(`Could not register SSH auth key: ${getErrorMessage(error)}`);
          return e.Option.none<Response>();
        })
      ),
    );
    if (e.Option.isNone(addRes) || addRes.value.ok) return;

    const message = yield* readResponseMessage(addRes.value);
    yield* e.Effect.logWarning(`Could not register SSH auth key: ${message}`);
  });

const createGitHubSigningKey = (
  githubToken: string,
  name: string,
  publicKey: string,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    yield* e.Effect.log(`Creating key on GitHub (signing): ${name}`);

    const addRes = yield* fetchResponse("https://api.github.com/user/ssh_signing_keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: publicKey, title: name }),
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll((error) =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(`Could not register SSH signing key: ${getErrorMessage(error)}`);
          return e.Option.none<Response>();
        }),
      ),
    );
    if (e.Option.isNone(addRes) || addRes.value.ok) return;

    const message = yield* readResponseMessage(addRes.value);
    yield* e.Effect.logWarning(`Could not register SSH signing key: ${message}`);
  });

const deleteGitHubAuthKey = (githubToken: string, keyId: number): e.Effect.Effect<void> =>
  fetchResponse(`https://api.github.com/user/keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  }).pipe(
    e.Effect.flatMap((response) => {
      if (response.ok) return e.Effect.void;
      return e.Effect.logWarning(`Could not replace stale SSH auth key id=${keyId} on GitHub.`);
    }),
    e.Effect.catchAll(() => e.Effect.logWarning(`Could not replace stale SSH auth key id=${keyId} on GitHub.`)),
  );

const deleteGitHubSigningKey = (githubToken: string, keyId: number): e.Effect.Effect<void> =>
  fetchResponse(`https://api.github.com/user/ssh_signing_keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  }).pipe(
    e.Effect.flatMap((response) => {
      if (response.ok) return e.Effect.void;
      return e.Effect.logWarning(`Could not replace stale SSH signing key id=${keyId} on GitHub.`);
    }),
    e.Effect.catchAll(() => e.Effect.logWarning(`Could not replace stale SSH signing key id=${keyId} on GitHub.`)),
  );

const fetchGitHubSession = (
  token: string,
  tokenScope: string,
  tokenType: string,
  refreshToken: string,
  refreshTokenExpiresInSeconds: number,
): e.Effect.Effect<e.Option.Option<GitHubSession>> =>
  e.Effect.gen(function*() {
    const userRes = yield* fetchResponse("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(userRes) || !userRes.value.ok) {
      yield* e.Effect.logError("Failed to fetch the GitHub profile.");
      return e.Option.none();
    }

    const user = yield* parseJson<{ id?: unknown; login: string; name?: unknown; email?: unknown }>(userRes.value).pipe(
      e.Effect.catchAll(() =>
        e.Effect.succeed({ login: "" } as { id?: unknown; login: string; name?: unknown; email?: unknown })
      ),
    );
    if (!user.login) {
      yield* e.Effect.logError("Failed to fetch the GitHub profile.");
      return e.Option.none();
    }

    let discoveredEmail = e.Option.fromNullable(typeof user.email === "string" ? user.email : undefined);
    if (e.Option.isNone(discoveredEmail)) {
      const verifiedEmails = yield* getVerifiedGitHubEmails(token);
      discoveredEmail = e.Option.fromNullable(verifiedEmails[0]);
    }

    const name = e.Option.fromNullable(typeof user.name === "string" ? user.name : undefined);
    const accountId = typeof user.id === "number" && Number.isFinite(user.id) ? user.id : 0;

    return e.Option.some({
      accountId,
      token,
      tokenScope,
      tokenType,
      refreshToken,
      refreshTokenExpiresInSeconds,
      username: user.login,
      name: e.Option.getOrElse(name, () => user.login),
      discoveredEmail: e.Option.getOrElse(discoveredEmail, () => ""),
    });
  });

const fetchAllGitHubKeys = (
  githubToken: string,
): e.Effect.Effect<e.Option.Option<{ auth: GitHubUserKey[]; signing: GitHubUserKey[] }>> =>
  e.Effect.gen(function*() {
    const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" };

    const authRes = yield* fetchResponse("https://api.github.com/user/keys", { headers }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(authRes) || !authRes.value.ok) return e.Option.none();

    const signingRes = yield* fetchResponse("https://api.github.com/user/ssh_signing_keys", { headers }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<Response>())),
    );
    if (e.Option.isNone(signingRes) || !signingRes.value.ok) return e.Option.none();

    const authRows = yield* parseJson<Array<{ id: number; key: string; title?: string }>>(authRes.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed([])),
    );
    const signingRows = yield* parseJson<Array<{ id: number; title?: string; key?: string }>>(signingRes.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed([])),
    );

    const auth = authRows.map((row) => ({
      id: row.id,
      key: row.key,
      title: row.title ?? parseKeyComment(row.key),
    } satisfies GitHubUserKey));

    const signing = signingRows.map((row) => ({
      id: row.id,
      key: row.key ?? "",
      title: row.title ?? parseKeyComment(row.key ?? ""),
    } satisfies GitHubUserKey));

    return e.Option.some({ auth, signing });
  });

const resolveJiveInventory = (
  githubToken: string,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory>,
): e.Effect.Effect<e.Option.Option<GitHubJiveKeyInventory>> =>
  e.Effect.gen(function*() {
    const all = yield* fetchAllGitHubKeys(githubToken);
    if (e.Option.isSome(all)) {
      return e.Option.some({
        auth: all.value.auth.filter(isJiveGitHubKey),
        signing: all.value.signing.filter(isJiveGitHubKey),
      });
    }

    return knownJiveInventory;
  });

function isJiveGitHubKey(key: GitHubUserKey): boolean {
  return key.title.startsWith(GITHUB_KEY_PREFIX) || parseKeyComment(key.key).startsWith(GITHUB_KEY_PREFIX);
}

function parseKeyComment(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 3) return "";
  return parts.slice(2).join(" ");
}

function normalizeArmoredKey(key: string): string {
  return key.trim().replace(/\r\n/g, "\n");
}

function normalizeKeyBody(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key.trim();
  return `${parts[0]} ${parts[1]}`;
}

function parsePositiveInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function hasScope(scopeList: string, scope: string): boolean {
  if (!scopeList) return false;
  const normalized = scopeList
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.includes(scope);
}

const forEachWorkspaceRepo = (
  root: string,
  git: WorkspaceGitApi,
  run: (org: string, repo: string) => e.Effect.Effect<void>,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    void root;
    const orgs = yield* git.localOrgs;
    for (const org of orgs) {
      const repos = yield* git.localRepos(org);
      for (const repo of repos) {
        yield* run(org, repo);
      }
    }
  });

const checkRepoAccess = (
  org: string,
  repo: string,
  githubToken: string,
): e.Effect.Effect<void> =>
  e.Effect.gen(function*() {
    const label = `@${org}/${repo}`;
    const res = yield* fetchResponse(`https://api.github.com/repos/${org}/${repo}`, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
    }).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchAll((error) =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(`Could not verify access to ${label}: ${getErrorMessage(error)}`);
          return e.Option.none<Response>();
        })
      ),
    );
    if (e.Option.isNone(res)) return;

    if (res.value.status === 404 || res.value.status === 403) {
      yield* e.Effect.logWarning(`No access to ${label} with this account.`);
      return;
    }

    if (!res.value.ok) return;

    const data = yield* parseJson<{ permissions?: { push: boolean } }>(res.value).pipe(
      e.Effect.catchAll(() => e.Effect.succeed({} as { permissions?: { push: boolean } })),
    );
    if (!data.permissions?.push) {
      yield* e.Effect.logWarning(`Read-only access to ${label}.`);
    }
  });

const fetchResponse = (input: string | URL, init?: RequestInit): e.Effect.Effect<Response> =>
  e.Effect.promise(() => fetch(input, init));

const parseJson = <A>(response: Response): e.Effect.Effect<A> =>
  e.Effect.promise(() => response.json() as Promise<A>);

const readResponseMessage = (response: Response): e.Effect.Effect<string> =>
  parseJson<{ message?: string }>(response).pipe(
    e.Effect.map((body) => body.message ?? String(response.status)),
    e.Effect.catchAll(() => e.Effect.succeed(String(response.status))),
  );

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
