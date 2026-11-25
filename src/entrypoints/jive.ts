import * as e from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cli, OSPlatformImpl } from "jive-abstract-library";
import { version } from "../../package.json";
import { ModulesLayer } from "@/modules/runtime";
import { jive } from "@/program";

/** Prints the help `jive <command…> --help` prints, on stderr, as `Cli` prints help beside words it can't run. */
const helpOnStderr = (command: ReadonlyArray<string>) => e.Effect.gen(function* () {
  const stdio = yield* e.Stdio.Stdio;
  yield* e.pipe(
    Cli.run(jive, { version }),
    e.Effect.provideService(e.Stdio.Stdio, e.Stdio.make({
      args: e.Effect.succeed([...command, "--help"]),
      stdout: (options) => stdio.stderr(options),
      stderr: (options) => stdio.stderr(options),
      stdin: stdio.stdin,
    })),
  );
});

BunRuntime.runMain(e.pipe(
  Cli.run(jive, { version }),
  e.Effect.catchTags({
    BadArgumentError: error => error.report(),
    BadPreconditionsError: error => error.report(),
    UsageError: error => e.Effect.andThen(helpOnStderr(error.command), error.report()),
  }),
  e.Effect.provide(ModulesLayer),
  e.Effect.provide(OSPlatformImpl.Layer),
  e.Effect.provide(Cli.terminalLogger),
  e.Effect.provide(BunServices.layer),
));
