import * as React from 'react';
import { Text } from 'ink';
import { subcommandPropMap, SubcommandSelector, subcommandsFromList } from '../../../../common/subcommand-selector';
import { ProjectType, projectTypeFromFolder, ProjectTypeToFolder } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';

export type PackageProps = {
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const TERMINAL_TEXT = 'hi';

const ProjectTypeHandler: React.FC<{projectType: ProjectType}> = ({projectType}) => {
  const [testing, setTesting] = React.useState('working...');
  React.useEffect(() => {
    setTimeout(() => {
      setTesting(TERMINAL_TEXT);
    }, 3000);
  }, []);
  return <>
    <Text>
      {projectType} hello world {testing}
    </Text>
    {testing === TERMINAL_TEXT && <Exit />}
  </>;
}

const possibleSubcommands = subcommandsFromList(Object.values(ProjectTypeToFolder));

const subcommandProperties = subcommandPropMap(possibleSubcommands, () => ({
  isTerminal: true,
  handler: ({subcommand}) => {
    const projectType = projectTypeFromFolder(subcommand);
    return <ProjectTypeHandler projectType={projectType} />
  }
}));

export const Package: React.FC<PackageProps> = ({args, argCollected}) => {
  const [initialPackageType, ...remainingArgs] = args;
  return <SubcommandSelector
    subcommands={possibleSubcommands}
    subcommandProperties={subcommandProperties}
    parentCommand='package'
    subcommandArg={initialPackageType}
    argCollected={argCollected}
  />
}
