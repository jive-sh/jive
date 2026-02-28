import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Effect } from "effect";
import { findWorkspaceRootSync, localOrgs, localRepos } from "./config";

const CLIENT_ID = "Ov23liKYxk1Ag7SsNhbP";
const CLIENT_SECRET = "e2901fbe93c591e7a53a903e70490ff87e998159";

// repo        — clone/push private repos, create repos
// user        — read profile + primary email
// read:org    — list org membership
// write:public_key — register SSH signing key
const SCOPES = "repo user read:org write:public_key";

const CREDENTIALS_FILE = ".jive/credentials.json";

export interface Credentials {
  token: string;
  githubUsername: string;
  githubName: string;
  githubEmail: string;
  sshSigningKeyPath?: string;
}

export function loadCredentials(): Credentials | null {
  const root = findWorkspaceRootSync();
  if (!root) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(root, CREDENTIALS_FILE), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

function saveCredentials(root: string, creds: Credentials): void {
  fs.writeFileSync(
    path.join(root, CREDENTIALS_FILE),
    JSON.stringify(creds, null, 2),
    { mode: 0o600 },
  );
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  const result = Bun.spawnSync([cmd, url]);
  if (result.exitCode !== 0) {
    console.log(`Could not open browser automatically. Visit this URL to authorize:\n  ${url}`);
  }
}

export async function login(): Promise<void> {
  const root = findWorkspaceRootSync();
  if (!root) {
    console.error("No .jive workspace found. Run `jive init` first.");
    return;
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("jive has no GitHub OAuth App configured yet.");
    console.error("Register one at https://github.com/settings/developers and set CLIENT_ID/CLIENT_SECRET in src/auth.ts.");
    return;
  }

  // 1. Start a local server on a random available port to receive the OAuth callback.
  const state = crypto.randomUUID();
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

      if (url.searchParams.get("state") !== state) {
        rejectCode(new Error("State mismatch — possible CSRF."));
        return new Response("State mismatch.", { status: 400 });
      }

      const code = url.searchParams.get("code");
      if (code) {
        resolveCode(code);
        return new Response(
          "<html><body><h2>Authorized! You can close this tab.</h2></body></html>",
          { headers: { "Content-Type": "text/html" } },
        );
      }

      const errMsg = url.searchParams.get("error_description")
        ?? url.searchParams.get("error") ?? "Unknown error";
      rejectCode(new Error(errMsg));
      return new Response(`Auth failed: ${errMsg}`, { status: 400 });
    },
  });

  const redirectUri = `http://localhost:${server.port}/callback`;

  // 2. Open the browser to GitHub's authorize page.
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);

  console.log("\nOpening GitHub in your browser...");
  openBrowser(authUrl.toString());
  process.stdout.write("Waiting for authorization...");

  // 3. Wait for the callback (5-minute timeout).
  const timeoutHandle = setTimeout(
    () => rejectCode(new Error("Login timed out. Please try again.")),
    5 * 60 * 1000,
  );

  let code: string;
  try {
    code = await codePromise;
  } catch (err) {
    console.error(`\n${(err as Error).message}`);
    return;
  } finally {
    clearTimeout(timeoutHandle);
    server.stop();
  }

  console.log(" done.\n");

  // 4. Exchange the authorization code for an access token.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) { console.error("Failed to exchange code for token."); return; }
  const tokenData = await tokenRes.json() as Record<string, string>;
  if (tokenData.error) { console.error(`Auth failed: ${tokenData.error_description ?? tokenData.error}`); return; }
  const token = tokenData.access_token;
  if (!token) { console.error("No access token received."); return; }

  // 5. Fetch GitHub user profile.
  const creds = await fetchGitHubUser(token);
  if (!creds) return;

  // 6. Generate/register a dedicated SSH key for this account.
  await setupSshKey(creds);

  // 7. Persist.
  saveCredentials(root, creds);
  console.log(`Logged in as @${creds.githubUsername} (${creds.githubEmail})`);

  // 8. Apply git user config and signing setup across the workspace.
  await applyToWorkspace(root, creds);
}

async function fetchGitHubUser(token: string): Promise<Credentials | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

  const userRes = await fetch("https://api.github.com/user", { headers });
  if (!userRes.ok) { console.error("Failed to fetch GitHub profile."); return null; }
  const user = await userRes.json() as { login: string; name: string | null; email: string | null };

  let email = user.email;
  if (!email) {
    // Public email may be hidden; fetch the verified primary email explicitly.
    const emailRes = await fetch("https://api.github.com/user/emails", { headers });
    if (emailRes.ok) {
      const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      email = emails.find(e => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
    }
  }

  return { token, githubUsername: user.login, githubName: user.name ?? user.login, githubEmail: email ?? "" };
}

async function setupSshKey(creds: Credentials): Promise<void> {
  const root = findWorkspaceRootSync()!;
  const keysDir = path.join(root, ".jive", "keys");
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(keysDir, creds.githubUsername);
  const pubKeyPath = `${keyPath}.pub`;

  // Generate a dedicated key for this account if one doesn't exist yet.
  if (!fs.existsSync(pubKeyPath)) {
    const result = Bun.spawnSync([
      "ssh-keygen", "-t", "ed25519",
      "-C", `jive/${creds.githubUsername}`,
      "-f", keyPath,
      "-N", "",
    ]);
    if (result.exitCode !== 0) {
      console.warn(yellow(`WARNING: could not generate SSH key for ${creds.githubUsername}`));
      return;
    }
  }

  const pubKey = fs.readFileSync(pubKeyPath, "utf8").trim();
  const keyBody = pubKey.split(" ").slice(0, 2).join(" "); // type + base64, no comment
  const headers = {
    Authorization: `Bearer ${creds.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const title = `jive (${os.hostname()})`;

  // Register as an SSH authentication key (used for git push/pull).
  const authListRes = await fetch("https://api.github.com/user/keys", { headers });
  if (authListRes.ok) {
    const existing = await authListRes.json() as Array<{ key: string }>;
    if (!existing.some(k => k.key.startsWith(keyBody))) {
      const addRes = await fetch("https://api.github.com/user/keys", {
        method: "POST", headers,
        body: JSON.stringify({ key: pubKey, title }),
      });
      if (!addRes.ok) {
        const err = await addRes.json() as { message?: string };
        console.warn(yellow(`WARNING: could not register SSH auth key: ${err.message ?? addRes.status}`));
      }
    }
  }

  // Register as an SSH signing key (used for verified commits).
  const signListRes = await fetch("https://api.github.com/user/ssh_signing_keys", { headers });
  if (signListRes.ok) {
    const existing = await signListRes.json() as Array<{ key: string }>;
    if (!existing.some(k => k.key.startsWith(keyBody))) {
      const addRes = await fetch("https://api.github.com/user/ssh_signing_keys", {
        method: "POST", headers,
        body: JSON.stringify({ key: pubKey, title }),
      });
      if (!addRes.ok) {
        const err = await addRes.json() as { message?: string };
        console.warn(yellow(`WARNING: could not register SSH signing key: ${err.message ?? addRes.status}`));
      }
    }
  }

  creds.sshSigningKeyPath = keyPath;
}

async function applyToWorkspace(root: string, creds: Credentials): Promise<void> {
  const orgs = await Effect.runPromise(localOrgs);
  for (const org of orgs) {
    const repos = await Effect.runPromise(localRepos(org));
    for (const repo of repos) {
      configureRepo(path.join(root, `@${org}`, repo), org, repo, creds);
      await checkRepoAccess(org, repo, creds);
    }
  }
}

function configureRepo(repoPath: string, org: string, repo: string, creds: Credentials): void {
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "ignore", stderr: "ignore" });

  git("config", "--local", "user.name", creds.githubName);
  git("config", "--local", "user.email", creds.githubEmail);
  git("remote", "set-url", "origin", `git@github.com:${org}/${repo}.git`);

  if (creds.sshSigningKeyPath) {
    git("config", "--local", "core.sshCommand", `ssh -i ${creds.sshSigningKeyPath} -o IdentitiesOnly=yes`);
    git("config", "--local", "gpg.format", "ssh");
    git("config", "--local", "user.signingkey", creds.sshSigningKeyPath);
    git("config", "--local", "commit.gpgsign", "true");
  }
}

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function checkRepoAccess(org: string, repo: string, creds: Credentials): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${org}/${repo}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/vnd.github+json" },
  });

  const label = `@${org}/${repo}`;
  if (res.status === 404 || res.status === 403) {
    console.warn(yellow(`WARNING: no access to ${label} with this account`));
  } else if (res.ok) {
    const data = await res.json() as { permissions?: { push: boolean } };
    if (!data.permissions?.push) {
      console.warn(yellow(`WARNING: read-only access to ${label}`));
    }
  }
}
