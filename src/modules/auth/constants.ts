import { TOOL_NAME } from "@/constants";
import { sanitizeKeyName, sshKeyId } from "../ssh/constants";

export const GITHUB_KEY_PREFIX = `${TOOL_NAME}:`;

export const authKeyName = (email: string, sshKeyName: string, sshKeyFingerprint: string): string =>
  `${GITHUB_KEY_PREFIX}${email}:${sanitizeKeyName(sshKeyName)}:${sshKeyId(sshKeyFingerprint)}`;

export const signingKeyName = (email: string, sshKeyName: string, sshKeyFingerprint: string): string =>
  `${GITHUB_KEY_PREFIX}${email}:${sanitizeKeyName(sshKeyName)}:${sshKeyId(sshKeyFingerprint)}`;
