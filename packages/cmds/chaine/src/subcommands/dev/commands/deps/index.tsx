import * as React from 'react';
import { Text, useStdout } from 'ink';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { SubcommandSelector } from '../../../../common/subcommand-selector';
import { Options } from '../../../../common/options';
import { run } from '../../../../common/run';

const Install: React.FC<{packagePath: string}> = ({packagePath}) => {
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    (async () => {
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
      // TODO: seems to work however output doesn't show up in cicd
      run('npx pnpm install', packagePath);
      setDone(true);
    })();
  }, []);
  return <>
    {done && <Exit />}
  </>
}

enum DependencyTypes {
  prod = 'prod',
  dev = 'dev',
  opt = 'opt',
  peer = 'peer'
}

const DEPENDENCY_TYPE_META: {[dependency in DependencyTypes]: {flag: string; full: string;}} = {
  [DependencyTypes.prod]: {
    full: 'dependencies',
    flag: '--save-prod'
  },
  [DependencyTypes.dev]: {
    full: 'devDependencies',
    flag: '--save-dev'
  },
  [DependencyTypes.opt]: {
    full: 'optionalDependencies',
    flag: '--save-optional'
  },
  [DependencyTypes.peer]: {
    full: 'peerDependencies',
    flag: '--save-peer'
  }
}

type AddProps = {
  packagePath: string;
  projectType: ProjectType;
  packageName: string;
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const AddImpl: React.FC<{addProps: AddProps; depType: DependencyTypes; args: string[]}> = props => {
  const {addProps: {packagePath, argCollected}, depType, args} = props;
  const [initialPackage, ...remainingArgs] = args;
  const [dependency, setDependency] = React.useState(initialPackage);
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    if (!dependency) return;
    const flag = DEPENDENCY_TYPE_META[depType].flag;
    run(`npx pnpm add ${flag} ${dependency}`, packagePath);
    setDone(true);
  }, [dependency]);
  React.useEffect(() => {
    if (dependency) {
      argCollected(true, dependency);
    }
  }, []);
  return <>
    {dependency === undefined && <>
      <Options
        options={[]}
        isValid={async packageName => true}
        onChosen={selection => {
          setDependency(selection);
          argCollected(true, selection);
        }}
        prompt={`package to add`}
      />
    </>}
    {done && <Exit />}
  </>
}

const Add: React.FC<AddProps> = props => {
  const {packageName, projectType, args, argCollected} = props;
  const [initialSubcommand, ...remainingArgs] = args;
  return <SubcommandSelector
    subcommands={DependencyTypes}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
    parentCommand='add'
    subcommandProperties={Object.fromEntries(Object.values(DependencyTypes).map(
      depType => [depType, {
        isTerminal: false,
        handler: () => <AddImpl 
          addProps={props}
          depType={depType}
          args={remainingArgs}
        />
      }]
    )) as any} // TODO: bad but readable. make type safe
  />
}

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
  return <SubcommandSelector 
    subcommands={Subcommands}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
    parentCommand='deps'
    subcommandProperties={{
      [Subcommands.add]: {
        isTerminal: false,
        handler: () => <Add 
          packagePath={path} 
          projectType={type}
          packageName={packageName}
          args={remainingArgs}
          argCollected={argCollected}
        />
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
