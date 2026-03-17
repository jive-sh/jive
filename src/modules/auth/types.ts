import type { SshKeySource } from "../ssh/types";

export interface Credentials {
  email: string;
  gitUserName: string;
  githubAccountId: number;
  githubUsername: string;
  readOnlyToken: string;
  readOnlyTokenScope: string;
  readOnlyTokenType: string;
  sshKeySource: SshKeySource;
  sshKeyFingerprint: string;
  sshKeyName: string;
  sshKeyPath: string;
  yubiKeySerial: string;
  writeRefreshToken: string;
}
