import { TOOL_NAME } from "@/constants";

export const WORKSPACE_SSH_DIR = `.${TOOL_NAME}/ssh`;
export const LOCAL_SSH_KEYS_DIR = `${WORKSPACE_SSH_DIR}/local`;
export const JIVE_SSH_APPLICATION = "ssh:jive";
export const DEFAULT_YUBIKEY_SSH_KEY_NAME = "yubikey-resident";

export function sanitizeKeyName(name: string): string {
  const normalized = name.trim().replace(/[:]+/g, "-").replace(/\s+/g, " ");
  return normalized || "unnamed";
}

export function sshKeyId(fingerprint: string): string {
  const normalized = fingerprint
    .trim()
    .replace(/^SHA256:/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_");

  return normalized || "unknown";
}
