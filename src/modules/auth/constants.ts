import { TOOL_NAME } from "@/constants";

export const GITHUB_KEY_PREFIX = `${TOOL_NAME}:`;
export const FIDO_APPLICATION = `ssh:${TOOL_NAME}`;

export const authKeyName = (email: string): string => `${GITHUB_KEY_PREFIX}${email}`;

export const signingKeyName = (email: string, yubiKeyId: string): string => `${GITHUB_KEY_PREFIX}${email}:${yubiKeyId}`;
