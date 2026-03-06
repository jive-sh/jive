import * as e from "effect";
import { IGit } from "../git/interface";
import { ModuleDependenciesLive } from "../runtime";
import { GITHUB_KEY_PREFIX } from "./constants";
import { parsePublicKey } from "./key-format";
import { requestOAuthCode } from "./oauth";
import type { GitHubJiveKeyInventory, GitHubSession, GitHubUserKey, YubiKeyJiveKey } from "./types";

const CLIENT_ID = "Ov23liKYxk1Ag7SsNhbP";
const CLIENT_SECRET = "e2901fbe93c591e7a53a903e70490ff87e998159";

// repo                — list/read private repos (and currently broader repo permissions for OAuth apps)
// user                — read profile + primary email
// read:org            — list org membership
const READ_SCOPES = "repo user read:org";

// write:public_key    — register SSH authentication keys (/user/keys)
// write:ssh_signing_key — register SSH signing keys (/user/ssh_signing_keys)
const WRITE_SCOPES = `${READ_SCOPES} write:public_key write:ssh_signing_key`;
const WRITE_KEY_SCOPES = ["write:public_key", "write:ssh_signing_key"] as const;
const REQUIRED_READ_SCOPES = ["repo", "user", "read:org"] as const;

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const runPromiseWithModules = <A, E>(effect: e.Effect.Effect<A, E, unknown>) =>
  e.Effect.runPromise(
    e.Effect.provide(effect, ModuleDependenciesLive) as e.Effect.Effect<A, E, never>,
  );
const logInfoSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.log(...message));
};
const logWarningSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logWarning(...message));
};
const logErrorSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logError(...message));
};

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

export function isGitHubOAuthConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

export async function loginToGitHubReadOnly(): Promise<e.Option.Option<GitHubSession>> {
  return loginToGitHubWithScopes(READ_SCOPES, "GitHub (read token)");
}

export async function loginToGitHubWrite(): Promise<e.Option.Option<GitHubSession>> {
  return loginToGitHubWithScopes(WRITE_SCOPES, "GitHub (write token)");
}

export async function renewWriteTokenFromRefresh(refreshToken: string): Promise<e.Option.Option<GitHubSession>> {
  return renewTokenFromRefresh(refreshToken, WRITE_SCOPES);
}

export async function renewReadOnlyTokenFromRefresh(refreshToken: string): Promise<e.Option.Option<GitHubSession>> {
  return renewTokenFromRefresh(refreshToken, READ_SCOPES);
}

export function isWriteCapableScope(scopeList: string): boolean {
  return WRITE_KEY_SCOPES.every((scope) => hasScope(scopeList, scope));
}

export function isReadScopeSatisfied(scopeList: string): boolean {
  return REQUIRED_READ_SCOPES.every((scope) => hasScope(scopeList, scope));
}

async function renewTokenFromRefresh(
  refreshToken: string,
  fallbackScope: string,
): Promise<e.Option.Option<GitHubSession>> {
  if (!refreshToken) return e.Option.none();

  // Try downscoping first; if GitHub ignores/rejects scope on refresh, retry without scope.
  const downscoped = await exchangeRefreshToken(refreshToken, fallbackScope);
  if (e.Option.isSome(downscoped)) return downscoped;

  return exchangeRefreshToken(refreshToken, "");
}

async function exchangeRefreshToken(
  refreshToken: string,
  requestedScope: string,
): Promise<e.Option.Option<GitHubSession>> {
  if (!refreshToken) return e.Option.none();

  const payload = new URLSearchParams();
  payload.set("client_id", CLIENT_ID);
  payload.set("client_secret", CLIENT_SECRET);
  payload.set("grant_type", "refresh_token");
  payload.set("refresh_token", refreshToken);
  if (requestedScope) payload.set("scope", requestedScope);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });

  if (!tokenRes.ok) return e.Option.none();

  const tokenData = await tokenRes.json() as TokenExchangeResponse;
  if (tokenData.error || !tokenData.access_token) return e.Option.none();

  return fetchGitHubSession(
    tokenData.access_token,
    tokenData.scope ?? requestedScope,
    tokenData.token_type ?? "bearer",
    tokenData.refresh_token ?? "",
    parsePositiveInteger(tokenData.refresh_token_expires_in),
  );
}

export async function getVerifiedGitHubEmails(githubToken: string): Promise<string[]> {
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" };
  const emailRes = await fetch("https://api.github.com/user/emails", { headers });

  if (!emailRes.ok) return [];

  const emails = await emailRes.json() as GitHubUserEmail[];
  return emails
    .filter((entry) => entry.verified)
    .map((entry) => entry.email)
    .filter(Boolean);
}

export async function listGitHubJiveKeys(githubToken: string): Promise<e.Option.Option<GitHubJiveKeyInventory>> {
  const all = await fetchAllGitHubKeys(githubToken);
  if (e.Option.isNone(all)) return e.Option.none();

  return e.Option.some({
    auth: all.value.auth.filter(isJiveGitHubKey),
    signing: all.value.signing.filter(isJiveGitHubKey),
  });
}

export async function ensureGitHubSigningJiveKey(
  githubToken: string,
  key: YubiKeyJiveKey,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory> = e.Option.none(),
): Promise<void> {
  const inventory = await resolveJiveInventory(githubToken, knownJiveInventory);
  if (e.Option.isNone(inventory)) {
    logWarningSync(yellow("WARNING: could not verify existing GitHub signing keys before registering jive key."));
    return;
  }

  await ensureSigningKey(githubToken, key, inventory.value.signing);
}

export async function ensureGitHubAuthKey(
  githubToken: string,
  keyName: string,
  publicKey: string,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory> = e.Option.none(),
): Promise<void> {
  const parsed = parsePublicKey(publicKey);
  if (e.Option.isNone(parsed)) {
    logWarningSync(yellow("WARNING: auth key was not parseable; skipping GitHub auth key update."));
    return;
  }

  const inventory = await resolveJiveInventory(githubToken, knownJiveInventory);
  if (e.Option.isNone(inventory)) {
    logWarningSync(yellow("WARNING: could not verify existing GitHub auth keys before registering jive key."));
    return;
  }

  await replaceAuthKeyByName(githubToken, keyName, publicKey, parsed.value.keyBody, inventory.value.auth);
}

export async function applyGitHubIdentityToWorkspace(
  root: string,
  session: GitHubSession,
  signingPublicKey: string,
  readOnlyAuthPrivateKeyPath: string,
  githubTokenForChecks: string,
): Promise<void> {
  await forEachWorkspaceRepo(root, async (org, repo) => {
    const configured = await runPromiseWithModules(
      e.Effect.gen(function*() {
        const git = yield* IGit;
        return yield* git.configureRepoRemoteAndUser(org, repo, {
          userName: session.name,
          userEmail: session.email,
          authPrivateKeyPath: readOnlyAuthPrivateKeyPath,
          signingPublicKey,
        });
      }),
    );
    if (!configured) {
      logWarningSync(yellow(`WARNING: could not apply git identity config to @${org}/${repo}`));
    }
    await checkRepoAccess(org, repo, githubTokenForChecks);
  });
}

export async function checkWorkspaceRepoAccess(root: string, githubToken: string): Promise<void> {
  await forEachWorkspaceRepo(root, async (org, repo) => {
    await checkRepoAccess(org, repo, githubToken);
  });
}

async function loginToGitHubWithScopes(scopes: string, providerName: string): Promise<e.Option.Option<GitHubSession>> {
  const auth = await requestOAuthCode(providerName, (redirectUri, state) => {
    const authUrl = new URL("https://github.com/login/oauth/authorize");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    return authUrl;
  });

  if (e.Option.isNone(auth)) return e.Option.none();

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: auth.value.code,
      redirect_uri: auth.value.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    logErrorSync("Failed to exchange GitHub OAuth code for token.");
    return e.Option.none();
  }

  const tokenData = await tokenRes.json() as TokenExchangeResponse;
  if (tokenData.error) {
    logErrorSync(`GitHub auth failed: ${tokenData.error_description ?? tokenData.error}`);
    return e.Option.none();
  }

  const token = tokenData.access_token;
  if (!token) {
    logErrorSync("No GitHub access token received.");
    return e.Option.none();
  }

  return fetchGitHubSession(
    token,
    tokenData.scope ?? scopes,
    tokenData.token_type ?? "bearer",
    tokenData.refresh_token ?? "",
    parsePositiveInteger(tokenData.refresh_token_expires_in),
  );
}

async function replaceAuthKeyByName(
  githubToken: string,
  keyName: string,
  publicKey: string,
  keyBody: string,
  existingAuth: GitHubUserKey[],
): Promise<void> {
  const sameName = existingAuth.filter((entry) => entry.title === keyName);
  for (const staleKey of sameName) {
    await deleteGitHubAuthKey(githubToken, staleKey.id);
  }

  const bodyMatch = existingAuth.find((entry) => normalizeKeyBody(entry.key) === keyBody && entry.title !== keyName);
  if (bodyMatch) {
    logWarningSync(yellow(`WARNING: auth key body already exists on GitHub with non-standard title \"${bodyMatch.title}\"`));
    return;
  }

  await createGitHubAuthKey(githubToken, keyName, publicKey);
}

async function ensureSigningKey(githubToken: string, key: YubiKeyJiveKey, existingSigning: GitHubUserKey[]): Promise<void> {
  const nameMatches = existingSigning.filter((entry) => entry.title === key.name);
  const nameAndBodyMatch = nameMatches.find((entry) => normalizeKeyBody(entry.key) === key.keyBody);
  if (nameAndBodyMatch) return;

  if (nameMatches.length > 0) {
    for (const staleKey of nameMatches) {
      await deleteGitHubSigningKey(githubToken, staleKey.id);
    }
  } else {
    const bodyMatch = existingSigning.find((entry) => normalizeKeyBody(entry.key) === key.keyBody);
    if (bodyMatch) {
      if (bodyMatch.title !== key.name) {
        logWarningSync(yellow(`WARNING: signing key already exists on GitHub with non-standard title \"${bodyMatch.title}\" (expected \"${key.name}\")`));
      }
      return;
    }
  }

  await createGitHubSigningKey(githubToken, key.name, key.publicKey);
}

async function createGitHubAuthKey(githubToken: string, name: string, publicKey: string): Promise<void> {
  logInfoSync(`Creating key on GitHub (auth): ${name}`);
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  const addRes = await fetch("https://api.github.com/user/keys", {
    method: "POST",
    headers,
    body: JSON.stringify({ key: publicKey, title: name }),
  });

  if (!addRes.ok) {
    const err = await addRes.json() as { message?: string };
    logWarningSync(yellow(`WARNING: could not register SSH auth key: ${err.message ?? addRes.status}`));
  }
}

async function createGitHubSigningKey(githubToken: string, name: string, publicKey: string): Promise<void> {
  logInfoSync(`Creating key on GitHub (signing): ${name}`);
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  const addRes = await fetch("https://api.github.com/user/ssh_signing_keys", {
    method: "POST",
    headers,
    body: JSON.stringify({ key: publicKey, title: name }),
  });

  if (!addRes.ok) {
    const err = await addRes.json() as { message?: string };
    logWarningSync(yellow(`WARNING: could not register SSH signing key: ${err.message ?? addRes.status}`));
  }
}

async function deleteGitHubAuthKey(githubToken: string, keyId: number): Promise<void> {
  const deleteRes = await fetch(`https://api.github.com/user/keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  });

  if (!deleteRes.ok) {
    logWarningSync(yellow(`WARNING: could not replace stale SSH auth key id=${keyId} on GitHub.`));
  }
}

async function deleteGitHubSigningKey(githubToken: string, keyId: number): Promise<void> {
  const deleteRes = await fetch(`https://api.github.com/user/ssh_signing_keys/${keyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
  });

  if (!deleteRes.ok) {
    logWarningSync(yellow(`WARNING: could not replace stale SSH signing key id=${keyId} on GitHub.`));
  }
}

async function fetchGitHubSession(
  token: string,
  tokenScope: string,
  tokenType: string,
  refreshToken: string,
  refreshTokenExpiresInSeconds: number,
): Promise<e.Option.Option<GitHubSession>> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) {
    logErrorSync("Failed to fetch GitHub profile.");
    return e.Option.none();
  }

  const user = await userRes.json() as { login: string; name?: unknown; email?: unknown };

  let email = e.Option.fromNullable(typeof user.email === "string" ? user.email : undefined);
  if (e.Option.isNone(email)) {
    const verifiedEmails = await getVerifiedGitHubEmails(token);
    email = e.Option.fromNullable(verifiedEmails[0]);
  }

  const name = e.Option.fromNullable(typeof user.name === "string" ? user.name : undefined);

  return e.Option.some({
    token,
    tokenScope,
    tokenType,
    refreshToken,
    refreshTokenExpiresInSeconds,
    username: user.login,
    name: e.Option.getOrElse(name, () => user.login),
    email: e.Option.getOrElse(email, () => ""),
  });
}

async function fetchAllGitHubKeys(githubToken: string): Promise<e.Option.Option<{ auth: GitHubUserKey[]; signing: GitHubUserKey[] }>> {
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" };

  const authRes = await fetch("https://api.github.com/user/keys", { headers });
  if (!authRes.ok) return e.Option.none();

  const signingRes = await fetch("https://api.github.com/user/ssh_signing_keys", { headers });
  if (!signingRes.ok) return e.Option.none();

  const authRows = await authRes.json() as Array<{ id: number; key: string; title?: string }>;
  const signingRows = await signingRes.json() as Array<{ id: number; key: string; title?: string }>;

  const auth = authRows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title ?? parseKeyComment(row.key),
  } satisfies GitHubUserKey));

  const signing = signingRows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title ?? parseKeyComment(row.key),
  } satisfies GitHubUserKey));

  return e.Option.some({ auth, signing });
}

async function resolveJiveInventory(
  githubToken: string,
  knownJiveInventory: e.Option.Option<GitHubJiveKeyInventory>,
): Promise<e.Option.Option<GitHubJiveKeyInventory>> {
  const all = await fetchAllGitHubKeys(githubToken);
  if (e.Option.isSome(all)) {
    return e.Option.some({
      auth: all.value.auth.filter(isJiveGitHubKey),
      signing: all.value.signing.filter(isJiveGitHubKey),
    });
  }

  return knownJiveInventory;
}

function isJiveGitHubKey(key: GitHubUserKey): boolean {
  return key.title.startsWith(GITHUB_KEY_PREFIX) || parseKeyComment(key.key).startsWith(GITHUB_KEY_PREFIX);
}

function parseKeyComment(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 3) return "";
  return parts.slice(2).join(" ");
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

async function forEachWorkspaceRepo(
  root: string,
  run: (org: string, repo: string) => Promise<void> | void,
): Promise<void> {
  const orgs = await runPromiseWithModules(
    e.Effect.gen(function*() {
      const git = yield* IGit;
      return yield* git.localOrgs;
    }),
  );
  for (const org of orgs) {
    const repos = await runPromiseWithModules(
      e.Effect.gen(function*() {
        const git = yield* IGit;
        return yield* git.localRepos(org);
      }),
    );
    for (const repo of repos) {
      await run(org, repo);
    }
  }
}

async function checkRepoAccess(org: string, repo: string, githubToken: string): Promise<void> {
  const label = `@${org}/${repo}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${org}/${repo}`, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
    });

    if (res.status === 404 || res.status === 403) {
      logWarningSync(yellow(`WARNING: no access to ${label} with this account`));
    } else if (res.ok) {
      const data = await res.json() as { permissions?: { push: boolean } };
      if (!data.permissions?.push) {
        logWarningSync(yellow(`WARNING: read-only access to ${label}`));
      }
    }
  } catch (error) {
    logWarningSync(yellow(`WARNING: could not verify access to ${label}: ${(error as Error).message}`));
  }
}
