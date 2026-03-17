export interface GitHubSession {
  accountId: number;
  token: string;
  tokenScope: string;
  tokenType: string;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  username: string;
  name: string;
  discoveredEmail: string;
}

export interface GitHubUserKey {
  id: number;
  key: string;
  title: string;
}

export interface GitHubJiveKeyInventory {
  auth: GitHubUserKey[];
  signing: GitHubUserKey[];
}
