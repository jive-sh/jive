import * as React from 'react';
import { Text } from 'ink';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { SubcommandSelector, subcommandsFromList } from '../../../../common/subcommand-selector';
import { Options } from '../../../../common/options';
import { run } from '../../../../common/run';
import * as path from 'path';
import * as fs from 'fs';

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
        options={{}}
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
        />,
        description: ''
      }]
    )) as any} // TODO: bad but readable. make type safe
  />
}

type RemoveProps = {
  packagePath: string;
  projectType: ProjectType;
  packageName: string;
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const RemoveImpl: React.FC<{removeProps: RemoveProps; packageName: string;}> = props => {
  const {removeProps, packageName} = props;
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    run(`npx pnpm remove ${packageName}`, removeProps.packagePath);
    setDone(true);
  }, []);
  return <>
    {done && <Exit />}
  </>
}

const Remove: React.FC<RemoveProps> = props => {
  const {packageName, projectType, packagePath, args, argCollected} = props;
  const [initialPackage, ...remainingArgs] = args;
  const [dependency, setDependency] = React.useState(initialPackage);
  const [allPossibleDependencies, setAllDependencies] = React.useState<undefined | Record<string, string>>();
  React.useEffect(() => {
    const packageJSONPath = path.resolve(packagePath, 'package.json');
    const packageJSONContents = fs.readFileSync(packageJSONPath).toString();
    const packageJSON = JSON.parse(packageJSONContents);
    const dependencies: Record<string, string[]> = {};
    for (const depType of Object.values(DependencyTypes)) {
      const packageJSONKey = DEPENDENCY_TYPE_META[depType].full;
      const allDepsForType = packageJSON[packageJSONKey];
      if (!allDepsForType) continue;
      for (const depPackageName in allDepsForType) {
        if (!(depPackageName in dependencies)) {
          dependencies[depPackageName] = [];
        }
        dependencies[depPackageName].push(packageJSONKey);
      }
    }
    const dependencyOptions: Record<string, string> = {};
    for (const dep in dependencies) {
      const dependencyTypes = dependencies[dep].join(', ');
      dependencyOptions[dep] = dependencyTypes;
    }
    setAllDependencies(dependencyOptions);
  }, []);
  return <>
    {allPossibleDependencies && <SubcommandSelector 
      parentCommand='remove'
      subcommands={subcommandsFromList(Object.keys(allPossibleDependencies))}
      subcommandArg={initialPackage}
      argCollected={argCollected}
      subcommandProperties={Object.fromEntries(
        Object.entries(allPossibleDependencies)
          .map(([packageName, packageDepTypes]) => [packageName, {
            isTerminal: true,
            handler: () => <RemoveImpl
              packageName={packageName}
              removeProps={props}
            />,
            description: packageDepTypes
          }]))}
    />}
  </>
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
  const { projectPath, projectType } = maybeProjectPath.value;
  return <SubcommandSelector 
    subcommands={Subcommands}
    subcommandArg={initialSubcommand}
    argCollected={argCollected}
    parentCommand='deps'
    subcommandProperties={{
      [Subcommands.add]: {
        isTerminal: false,
        handler: () => <Add 
          packagePath={projectPath} 
          projectType={projectType}
          packageName={packageName}
          args={remainingArgs}
          argCollected={argCollected}
        />,
        description: ''
      },
      [Subcommands.install]: {
        isTerminal: true,
        handler: () => <Install packagePath={projectPath} />,
        description: ''
      },
      [Subcommands.remove]: {
        isTerminal: false,
        handler: () => <Remove
          packagePath={projectPath}
          projectType={projectType}
          packageName={packageName}
          args={remainingArgs}
          argCollected={argCollected}
        />,
        description: ''
      },
      [Subcommands.update]: {
        isTerminal: false,
        handler: () => <Text>Updating<Exit /></Text>,
        description: ''
      }
    }}
  />
}
