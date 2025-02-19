import * as React from 'react';
import { Text } from 'ink';
import { Exit } from '../../../../common/exit';
import * as path from 'path';
import { MONOREPO_ROOT } from '../../../../common/paths';
import dependencyGraph from '../../../../../../../../docker/dependency-graph.json';
import { gitChangedFiles } from '../../../../common/git';
import { Graph } from '../../../../common/graph';

export type DockerProps = {

}

function getRebuildGraph() {
  const changedFiles = gitChangedFiles();
  const prefix = "docker/Dockerfile.";
  const changedDockerfiles = new Set(changedFiles
    .filter(filename => filename.startsWith(prefix))
    .map(dockerfilePath => dockerfilePath.substring(prefix.length)));
  const graphOfAllDockerfiles = Graph.fromEdgeMap(dependencyGraph);
  const dockerfilesToRebuildGraph = new Graph();
  // Start with changed files, dfs until all dockerfiles that transitively
  // depend on the changed files are added.
  function dfs(image: string, from?: string) {
    if (dockerfilesToRebuildGraph.hasNode(image)) {
      if (from) {
        dockerfilesToRebuildGraph.addEdge(from, image);
      }
      return;
    }
    dockerfilesToRebuildGraph.addNode(image);
    if (from) {
      dockerfilesToRebuildGraph.addEdge(from, image);
    }
    for (const to of graphOfAllDockerfiles.getNodesDependentOn(image)) {
      dfs(to, image);
    }
  }
  for (const image of Array.from(changedDockerfiles)) {
    dfs(image);
  }
  return dockerfilesToRebuildGraph;
}

export const Docker: React.FC<DockerProps> = () => {
  const [n, setN] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    const dockerPath = path.resolve(MONOREPO_ROOT, 'docker');
    const g = getRebuildGraph();
    setN(g.getNodes().join(', '));
  }, [])
  return <>
    <Text>{n}</Text>
    <Exit />
  </>
}

// 

// // Topological sort dockerfile dependencies to achieve accurate build order
// const buildOrder = topologicalSort(dockerFileDependencies);



// const finalBuildOrder = [];
// for (const cur of buildOrder) {
//   if (changedDockerfiles.has(cur)) {
//     finalBuildOrder.push(cur);
//   }
// }
// const output = {image_name: finalBuildOrder}
// console.log(`::set-output name=build-matrix::${JSON.stringify(output)}`);
