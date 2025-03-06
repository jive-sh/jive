import * as React from 'react';
import { subcommandPropMap, SubcommandSelector, subcommandsFromList } from '../../../../common/subcommand-selector';
import { ProjectType, projectTypeFromFolder, ProjectTypeToFolder, projectTypePathFromRoot } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { gitChangedFiles, setGHAOutput } from '../../../../common/git';
import * as path from 'path';

export type PackageProps = {
  args: string[];
  argCollected: (all: boolean, latest?: string) => void;
}

const ProjectTypeHandler: React.FC<{projectType: ProjectType}> = ({projectType}) => {
  const [done, setDone] = React.useState(false);
  React.useEffect(() => {
    (async () => {
      const projectTypePath = projectTypePathFromRoot(projectType);
      const folder = ProjectTypeToFolder[projectType];
      const changedProjectsOfType = Array.from(new Set(gitChangedFiles()
        .filter(changedFile => changedFile.startsWith(projectTypePath))
        .map(changedFile => changedFile
          .substring(projectTypePath.length)
          .split(path.sep)[1])).values());
      setGHAOutput(`changed-${folder}`, JSON.stringify({
        [projectType]: changedProjectsOfType
      }));
      setDone(true);
    })();
  }, []);
  return <>
    {done && <Exit />}
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
