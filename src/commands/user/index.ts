import { Console, Effect } from "effect";
import { Command } from "@effect/cli";
import { ArgEmail } from "@/arguments";
import { pending } from "@/common/utils";
import { loadUserState } from "@/state/user";

const userListCommand = Command
  .make("list", {}, () =>
    Effect.gen(function* () {
      try {

        yield* Console.log("test log");

        const state = yield* loadUserState;

        if (state.users.length === 0) {
          yield* Console.log("No users configured. Run `jive user login <email>` to add one.");
          return;
        }

        yield* Console.log("Configured users:");

        for (const email of state.users) {
          const suffix = state.activeUser === email ? " (active)" : "";
          yield* Console.log(`- ${email}${suffix}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield* Console.error(`Failed to list users: ${message}`);
        yield* Effect.fail(error);
      }
    })
  )
  .pipe(Command.withDescription("List available Jive users."));

const userLoginCommand = Command
  .make("login", { email: ArgEmail }, ({ email }) => {
    return pending(`login user "${email}".`);
  })
  .pipe(Command.withDescription("Log a user in to the CLI."));

const userLogoutCommand = Command
  .make("logout", { email: ArgEmail }, ({ email }) => pending(`logout user "${email}".`))
  .pipe(Command.withDescription("Log a user out of the CLI."));

const userSwitchCommand = Command
  .make("switch", {}, () => pending("switch active user."))
  .pipe(Command.withDescription("Switch the active user context."));

export const userCommand = Command
  .make("user", {}, () => Console.log("Select a subcommand to manage users."))
  .pipe(Command.withDescription("Manage Jive CLI users."))
  .pipe(Command.withSubcommands([
    userListCommand,
    userLoginCommand,
    userLogoutCommand,
    userSwitchCommand
  ]));
