export interface Credentials {
  email: string;
  gitUserName: string;
  readOnlyToken: string;
  readOnlyTokenScope: string;
  readOnlyTokenType: string;
  readOnlyAuthPrivateKeyPath: string;
  readOnlyAuthPublicKeyPath: string;
  writeRefreshToken: string;
}

export interface GitHubSession {
  token: string;
  tokenScope: string;
  tokenType: string;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  username: string;
  name: string;
  email: string;
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

export interface YubiKeyJiveKey {
  name: string;
  email: string;
  publicKey: string;
  keyBody: string;
}

export interface ConnectedYubiKeyDevice {
  id: string;
  label: string;
}

export interface ParsedPublicKey {
  keyBody: string;
  comment: string;
}

export interface LocalAuthKey {
  name: string;
  publicKey: string;
  keyBody: string;
  privateKeyPath: string;
  publicKeyPath: string;
}
