import { Options } from '../../common/options';
import { Text } from 'ink';
import * as React from 'react';
import { Exit } from '../../common/exit';
import { ProjectType, getPrefix, getProjectList, getProjectType, getProjects } from '../../common/projects';
import { TEMPLATE_PACKAGE_NAME } from '../../common/consts';
import { NewPackage } from './commands/new';
import { SubcommandSelector } from '../../common/subcommand-selector';
import { Deps } from './commands/deps';
import { Build } from './commands/build';
import { Publish } from './commands/publish';
import { Deploy } from './commands/deploy';

/**
 * dev [package name]
 *  deps [add remove update | package name] or [install]
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
  build = 'build',
  deploy = 'deploy',
  deps = 'deps',
  infra = 'infra',
  link = 'link',
  new = 'new',
  precommit = 'precommit',
  publish = 'publish',
  run = 'run',
  template = 'template',
  test = 'test',
  unlink = 'unlink'
}

type SubcommandsProjectTypeEligibility = {
  [subcommand in Subcommands]: {
    [projectType in ProjectType]: boolean;
  }
}

const subcommandEligibility: SubcommandsProjectTypeEligibility = {
  [Subcommands.build]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.deploy]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: false,
    [ProjectType.Library]: false,
    [ProjectType.Service]: true
  },
  [Subcommands.deps]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.infra]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: false,
    [ProjectType.Library]: false,
    [ProjectType.Service]: true
  },
  [Subcommands.link]: {
    [ProjectType.Application]: false,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: false
  },
  [Subcommands.new]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.precommit]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.publish]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.run]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  // Only present when package is a template
  [Subcommands.template]: {
    [ProjectType.Application]: false,
    [ProjectType.Command]: false,
    [ProjectType.Library]: false,
    [ProjectType.Service]: false
  },
  [Subcommands.test]: {
    [ProjectType.Application]: true,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: true
  },
  [Subcommands.unlink]: {
    [ProjectType.Application]: false,
    [ProjectType.Command]: true,
    [ProjectType.Library]: true,
    [ProjectType.Service]: false
  }
}

subcommandEligibility;

const projectsList = await getProjectList();

export type DevCommandProps = {
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

export const DevCommand: React.FC<DevCommandProps> = ({args, argCollected}) => {
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [initialPackage, initialSubcommand, ...remainingArgs] = args;
  const [packageName, setPackageName] = React.useState<string | undefined>(initialPackage);
  const [subcommand, setSubcommand] = React.useState<string | undefined>(initialSubcommand);
  const isNew = !projectsList.includes(packageName ?? "");
  const possibleSubcommands: Subcommands[] = [];
  React.useEffect(() => {
    if (initialPackage !== undefined) {
      argCollected(false, initialPackage);
    }
    setIsInitialized(true);
  }, []);
  if (isNew) {
    possibleSubcommands.push(Subcommands.new);
  } else if(packageName) {
    const maybeProjectType = getProjectType(packageName);
    if (!maybeProjectType.success) {
      return <>
        <Text>Invariant encountered. {maybeProjectType.reason}</Text>
        <Exit />
      </>;
    }
    const projectType = maybeProjectType.value;
    const prefix = getPrefix(projectType);
    
    const isTemplate = packageName.substring(prefix.length) === TEMPLATE_PACKAGE_NAME;
    if (isTemplate) {
      possibleSubcommands.push(Subcommands.template);
    }

    Object.values(Subcommands).forEach(subcommand => {
      if(subcommandEligibility[subcommand][projectType]) {
        possibleSubcommands.push(subcommand);
      }
    });
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
    {isInitialized && <>
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
            subcommandSubset={possibleSubcommands}
            subcommandProperties={{
              [Subcommands.build]: {
                isTerminal: true,
                handler: () => <Build packageName={packageName} projectType={projectType} />
              },
              [Subcommands.deploy]: {
                isTerminal: true,
                handler: () => <Deploy packageName={packageName} projectType={projectType} />
              },
              [Subcommands.deps]: {
                isTerminal: false,
                handler: () => <Deps 
                  packageName={packageName}
                  argCollected={argCollected}
                  args={remainingArgs}
                />
              },
              [Subcommands.new]: {
                isTerminal: true,
                handler: () => <NewPackage packageName={packageName} projectType={projectType} />
              },
              [Subcommands.test]: {
                isTerminal: false,
                handler: defaultHandler
              },
              [Subcommands.run]: {
                isTerminal: false,
                handler: defaultHandler
              },
              [Subcommands.precommit]: {
                isTerminal: true,
                handler: defaultHandler
              },
              [Subcommands.publish]: {
                isTerminal: true,
                handler: () => <Publish packageName={packageName} projectType={projectType} />
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
    </>}
  </>
}
