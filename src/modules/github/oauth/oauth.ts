import * as e from "effect";
import * as net from "node:net";
import { Client, Token } from "oauth2-cli";
import { TOOL_NAME } from "@/constants";

export const CLIENT_ID = "Ov23liKYxk1Ag7SsNhbP";
// TODO: move this behind a dedicated workspace-owned secret boundary.
export const CLIENT_SECRET = "e2901fbe93c591e7a53a903e70490ff87e998159";

export const READ_SCOPES = "repo user read:org read:public_key read:ssh_signing_key";
export const WRITE_SCOPES = `${READ_SCOPES} write:public_key write:ssh_signing_key admin:ssh_signing_key`;

const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const REDIRECT_PATH = "/callback";

class GitHubOAuthStorage implements Token.Storage {
  private refreshToken: string | undefined;

  constructor(refreshToken?: string) {
    this.refreshToken = refreshToken;
  }

  async load(): Promise<string | undefined> {
    return this.refreshToken;
  }

  async save(refresh_token: string): Promise<void> {
    this.refreshToken = refresh_token;
    // TODO: persist refresh tokens through the tool-state workspace boundary.
  }
}

export interface CreateGitHubOAuthClientOptions {
  readonly scope: string;
  readonly refreshToken?: string;
  readonly promptAccountSelection?: boolean;
  readonly preferredUsername?: string;
}

export interface GitHubOAuthClient {
  readonly client: Client;
  readonly redirectUri: string;
}

export const createGitHubOAuthClient = e.Effect.fn(function*({
  scope,
  refreshToken,
  promptAccountSelection = false,
  preferredUsername,
}: CreateGitHubOAuthClientOptions) {
  const port = 0; // TODO: let's test this behavior. If redirect uri doesn't update to match server port we can just use 3000 while issue is filed.
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`;
  const search = new URLSearchParams();
  search.set("allow_signup", "false");
  if (promptAccountSelection) {
    search.set("prompt", "select_account");
  }
  if (preferredUsername) {
    search.set("login", preferredUsername);
  }

  const client = new Client({
    name: "GitHub",
    reason: TOOL_NAME,
    credentials: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      authorization_endpoint: "https://github.com/login/oauth/authorize",
      token_endpoint: "https://github.com/login/oauth/access_token",
      scope,
    },
    inject: {
      search,
    },
    localhost: {
      timeout: OAUTH_TIMEOUT_MS,
    },
    storage: new GitHubOAuthStorage(refreshToken),
  });

  return {
    client,
    redirectUri,
  };
});
