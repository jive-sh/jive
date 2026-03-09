import * as e from "effect";
import type { HostShellCommand, HostShellCommandResult } from "@/modules/host-shell/interface";

export interface AuthHostShell {
  readonly commandExists: (command: string) => e.Effect.Effect<boolean>;
  readonly missingCommands: (commands: readonly string[]) => e.Effect.Effect<string[]>;
  readonly run: (command: HostShellCommand) => e.Effect.Effect<e.Option.Option<HostShellCommandResult>>;
}
