import * as e from "effect";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import type { HostShellCommand, HostShellCommandResult } from "@/modules/host-shell/interface";

export const SSH_KEYGEN_COMMAND = "ssh-keygen" as const;
export const SSH_ADD_COMMAND = "ssh-add" as const;
export const REQUIRED_OPENSSH_COMMANDS = [SSH_KEYGEN_COMMAND, SSH_ADD_COMMAND] as const;
type OpenSshCommand = (typeof REQUIRED_OPENSSH_COMMANDS)[number];

export const runOpenSshCommand = (
  hostShell: AuthHostShell,
  spec: HostShellCommand & { readonly command: OpenSshCommand },
): e.Effect.Effect<e.Option.Option<HostShellCommandResult>> => hostShell.run(spec);
