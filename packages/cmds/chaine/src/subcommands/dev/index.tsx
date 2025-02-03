import { Options } from '../../common/options';
import { Text } from 'ink';
import * as React from 'react';
import { Exit } from '../../common/exit';
import { ProjectType, getPrefix, getProjectType, getProjects, TEMPLATE_PACKAGE_NAME } from '../../common/projects';
import { NewPackage } from './commands/new';

/**
 * dev [package name]
 *  bun [...bun cli args]
 *  new
 *  test [test blob list]
 *  run [script name]
 *  publish
 *  link (only works for libraries and maybe commands)
 *  unlink (only works for libraries and maybe commands)
 *  infra [apply|dry] (only works for services)
 */

// ?❯…·✖✔

enum Subcommands {
  bun = 'bun',
  new = 'new',
  test = 'test',
  run = 'run',
  publish = 'publish',
  link = 'link',
  unlink = 'unlink',
  infra = 'infra',
  template = 'template',
}

// terminal meaning no args collected after
export const IS_COMMAND_TERMINAL: {[subcommand in Subcommands]: boolean} = {
  [Subcommands.bun]: false,
  [Subcommands.new]: true,
  [Subcommands.test]: false,
  [Subcommands.run]: false,
  [Subcommands.publish]: true,
  [Subcommands.link]: true,
  [Subcommands.unlink]: true,
  [Subcommands.infra]: false,
  [Subcommands.template]: false
}

const projects = await getProjects();
const projectsList: string[] = [];
for (const projectType in projects) {
  const curProjects = projects[projectType as ProjectType];
  projectsList.push(...curProjects);
}
projectsList.sort();

export type DevCommandProps = {
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

export const DevCommand: React.FC<DevCommandProps> = ({args, argCollected}) => {
  const [initialPackage, initialSubcommand, ...remainingArgs] = args;
  const [packageName, setPackageName] = React.useState<string | undefined>(initialPackage);
  const [subcommand, setSubcommand] = React.useState<string | undefined>(initialSubcommand);
  const isNew = !projectsList.includes(packageName ?? "");
  React.useEffect(() => {
    if (initialPackage === undefined || initialSubcommand === undefined) {
      argCollected(false);
    }
  }, []);
  React.useEffect(() => {
    if (IS_COMMAND_TERMINAL[subcommand as Subcommands]) {
      argCollected(true);
    }
  }, [subcommand]);
  const possibleSubcommands: string[] = [];
  if (isNew) {
    possibleSubcommands.push(Subcommands.new);
  } else {
    const maybeProjectType = getProjectType(packageName ?? "");
    if (!maybeProjectType.success) {
      return <>
        <Text>Invariant encountered. {maybeProjectType.reason}</Text>
        <Exit />
      </>;
    }
    const projectType = maybeProjectType.value;
    const prefix = getPrefix(projectType);
    // TODO: probably want a type safe confirmation that package name is present
    const isTemplate = packageName!.substring(prefix.length) === 'TEMPLATE';
    if (packageName)
    possibleSubcommands.push(
      Subcommands.bun, Subcommands.test, Subcommands.run, Subcommands.publish
    );
    packageName 
    
    switch (projectType) {
      case ProjectType.Command:
      case ProjectType.Library:
        possibleSubcommands.push(
          Subcommands.link, Subcommands.unlink
        );
        break;
      case ProjectType.Service:
      case ProjectType.Application:
        possibleSubcommands.push(Subcommands.infra);
        break;
      default:
        return <>
          <Text>Invariant encountered. Unhandled project type '{projectType}'</Text>
          <Exit />
        </>
    }
  }
  possibleSubcommands.sort();
  function validatePackageName(packageName: string): {valid: true, projectType: ProjectType} | {valid: false}  {
    const maybeProjectType = getProjectType(packageName);
    if (!maybeProjectType.success) return {valid: false};
    const prefix = getPrefix(maybeProjectType.value);
    if (prefix.length === packageName.length) return {valid: false};
    return {valid: true, projectType: maybeProjectType.value};
  }
  return <>
    {initialPackage === undefined && 
      <Options
        options={projectsList}
        isValid={async packageName => validatePackageName(packageName).valid}
        onChosen={selection => {
          setPackageName(selection);
          argCollected(false, selection);
        }}
        prompt='package name'
      />
    }
    {packageName && (() => {
      const maybePackageValid = validatePackageName(packageName);
      if (!maybePackageValid.valid) {
        return <>
          <Text>Package name '{packageName}' is invalid</Text>
          <Exit />
        </>;
      }
      const projectType = maybePackageValid.projectType;
      return <>
        {initialSubcommand === undefined &&
          <Options
            options={possibleSubcommands}
            onChosen={selection => {
              setSubcommand(selection);
              argCollected(false, selection);
            }}
            prompt="'dev' subcommand"
          />
        }
        {subcommand && (() => {
          // validate subcommand
          if (!possibleSubcommands.includes(subcommand)) {
            const validOptions = possibleSubcommands.map(subcommand => `'${subcommand}'`).join(', ');
            return <>
              <Text>Invalid subcommand '{subcommand}' for {isNew ? 'new' : 'existing'} package '{packageName}'.</Text>
              <Text>Valid options are {validOptions}</Text>
              <Exit />
            </>
          }
          function defaultHandler() {
            return <>
              <Text>Running {subcommand} on package {packageName}</Text>
              <Text>Not yet implemented!</Text>
              <Exit />
            </>;
          }
          // execute subcommand
          const subcommandHandlers: {[subcommand in Subcommands]: React.FC} = {
            [Subcommands.new]: () => <NewPackage packageName={packageName} projectType={projectType} />,
            [Subcommands.bun]: defaultHandler,
            [Subcommands.test]: defaultHandler,
            [Subcommands.run]: defaultHandler,
            [Subcommands.publish]: defaultHandler,
            [Subcommands.link]: defaultHandler,
            [Subcommands.unlink]: defaultHandler,
            [Subcommands.infra]: defaultHandler
          }
          return subcommandHandlers[subcommand as Subcommands]({});
        })()}
      </>;
    })()}
  </>
}
