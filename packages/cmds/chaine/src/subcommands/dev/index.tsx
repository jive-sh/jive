import { Options } from '../../common/options';
import { Text } from 'ink';
import * as React from 'react';
import { Exit } from '../../common/exit';
import { ProjectType, getPrefix, getProjectType, getProjects } from '../../common/projects';
import { TEMPLATE_PACKAGE_NAME } from '../../common/consts';
import { NewPackage } from './commands/new';
import { SubcommandSelector } from '../../common/subcommand-selector';

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
      function defaultHandler({subcommand}: {subcommand: string}) {
        return <>
          <Text>Running {subcommand} on package {packageName}</Text>
          <Text>Not yet implemented!</Text>
          <Exit />
        </>;
      }
      return <>
        <SubcommandSelector 
          subcommands={Subcommands}
          subcommandProperties={{
            [Subcommands.bun]: {
              isTerminal: false,
              handler: () => <NewPackage packageName={packageName} projectType={projectType} />
            },
            [Subcommands.new]: {
              isTerminal: true,
              handler: defaultHandler
            },
            [Subcommands.test]: {
              isTerminal: false,
              handler: defaultHandler
            },
            [Subcommands.run]: {
              isTerminal: false,
              handler: defaultHandler
            },
            [Subcommands.publish]: {
              isTerminal: true,
              handler: defaultHandler
            },
            [Subcommands.link]: {
              isTerminal: true,
              handler: defaultHandler
            },
            [Subcommands.unlink]: {
              isTerminal: true,
              handler: defaultHandler
            },
            [Subcommands.infra]: {
              isTerminal: false,
              handler: defaultHandler
            },
            [Subcommands.template]: {
              isTerminal: false,
              handler: defaultHandler
            }
          }}
          subcommandArg={initialSubcommand}
          parentCommand={`dev ${packageName}`}
          argCollected={(all, latest) => { 
            if (latest && !subcommand) {
              setSubcommand(subcommand);
            }
            argCollected(all, latest);
          }}
        />
      </>;
    })()}
  </>
}
