import * as React from 'react';
import { Text } from 'ink';
import { getProjectPath } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { SubcommandSelector } from '../../../../common/subcommand-selector';
import { MONOREPO_ROOT } from '../../../../common/paths';
import { execDependencyCLI } from '../../../../common/exec-dependency-cli';
import { pipeProcOutput } from '../../../../common/pipe-proc-output';
import * as path from 'path';
import { exec, execSync } from 'child_process';

enum Subcommands {
  add = 'add',
  remove = 'remove',
  update = 'update',
  install = 'install'
}

export type DepsProps = {
  packageName: string;
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const Install: React.FC<{packagePath: string}> = ({packagePath}) => {
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    (async () => {
      const pathInRepo = packagePath.substring(MONOREPO_ROOT.length + path.sep.length);
      console.log(`Running pnpm install at ${pathInRepo}`);
      /*const installProc = execDependencyCLI({
        dependency: 'pnpm',
        dir: packagePath,
        args: ['install']
      });*/
      /*
      const installProc = exec('npx pnpm install', {cwd: packagePath});
      const {done, lines} = pipeProcOutput(installProc, {toConsole: false, toBuffer: true});
      for await (const {stream, line} of lines) {
        console.log(line);
      }
      await done;
      */
      execSync('npx pnpm install', {cwd: packagePath, stdio: 'inherit'});
      execSync('ls -la ./node_modules', {cwd: packagePath, stdio: 'inherit'});
      setDone(true);
    })();
  }, []);
  return <>
    {done && <Exit />}
  </>
}

export const Deps: React.FC<DepsProps> = props => {
  const {packageName, args, argCollected} = props;
  const [initialSubcommand, ...remainingArgs] = args;
  const maybeProjectPath = getProjectPath(packageName);
  if (!maybeProjectPath.success) {
    return <Text>
      Invalid package name {packageName}: {maybeProjectPath.reason}
      <Exit />
    </Text>
  }
  const { path, type } = maybeProjectPath.value;
  // # npx --quiet pnpm install && npx expo export --platform web
  return <SubcommandSelector 
    subcommands={Subcommands}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
    parentCommand='deps'
    subcommandProperties={{
      [Subcommands.add]: {
        isTerminal: false,
        handler: () => <Text>Adding<Exit /></Text>
      },
      [Subcommands.install]: {
        isTerminal: true,
        handler: () => <Install packagePath={path} />
      },
      [Subcommands.remove]: {
        isTerminal: false,
        handler: () => <Text>Removing<Exit /></Text>
      },
      [Subcommands.update]: {
        isTerminal: false,
        handler: () => <Text>Updating<Exit /></Text>
      }
    }}
  />
}
