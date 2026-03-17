export type SshKeySource = "local" | "yubikey";

export interface SshJiveKey {
  source: SshKeySource;
  fingerprint: string;
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  publicKey: string;
  relativePrivateKeyPath: string;
  yubiKeySerial: string;
}

export interface ParsedPublicKey {
  keyBody: string;
  comment: string;
}
