import * as React from 'react';
import { Text } from 'ink';
import { Exit } from '../../../../common/exit';
import { MONOREPO_ROOT } from '../../../../common/paths';
import dependencyGraph from '../../../../../../../../docker/dependency-graph.json';
import { gitChangedFiles } from '../../../../common/git';
import { Graph } from '../../../../common/graph';
import { parallelTopologicalSort } from '../../../../common/parallel-topo-sort';
import * as child_process from 'node:child_process';
import { pipeProcOutput } from '../../../../common/pipe-proc-output';
import { GIT_ORG } from '../../../../common/consts';

export type DockerProps = {

}

// TODO: write some unit tests. Probably breaks on 
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

type Status = Record<string, {start?: number; outbound: string[]; end?: number; }>;

export const Docker: React.FC<DockerProps> = () => {
  const [done, setDone] = React.useState<boolean>(false);
  const [status, setStatus] = React.useState<Status>({});
  const [elapsed, setElapsed] = React.useState<number>(0);
  function isDone(image: string) {
    const imageStatus = status[image];
    if (!imageStatus) return false;
    return !!imageStatus.end;
  }
  function hasStarted(image: string) {
    const imageStatus = status[image];
    if (!imageStatus) return false;
    return !!status[image].start;
  }
  function time(image: string) {
    const end = status[image].end ?? Date.now();
    return Math.round((end - status[image].start!) / 1000);
  }
  React.useEffect(() => {
    const rebuildGraph = getRebuildGraph();
    const startTime = Date.now();
    const status: Status = {};
    function updateStatus() {
      setStatus(JSON.parse(JSON.stringify(status)));
    }
    const intervalId = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime) / 1000));
    }, 1000);

    let nodeWithLongestName = '';
    for (const node of rebuildGraph.getNodes()) {
      status[node] = {outbound: rebuildGraph.getNodesDependentOn(node)};
      if (node.length > nodeWithLongestName.length) {
        nodeWithLongestName = node;
      }
    }
    updateStatus();
    const imagePrefixLength = `[${nodeWithLongestName}]`.length;
    
    (async () => {
      await parallelTopologicalSort(rebuildGraph, async image => {
        status[image].start = Date.now();
        updateStatus();
        
        const prefix = `[${image}]`.padStart(imagePrefixLength, ' ');

        async function run(...args: string[]) {
          const cmd = args.join(" ");
          console.log(`${prefix} ${cmd}`);
          const proc = child_process.exec(cmd, {cwd: MONOREPO_ROOT});
          const {lines, done} = pipeProcOutput(proc, {toConsole: false, toBuffer: true});
          for await (const {line, stream} of lines) {
            console.log(`${prefix}[${stream}] ${line}`);
          }
          const {code} = await done;
          if (code !== 0) {
            console.log(`${prefix} exited with code ${code}. Killing process w/ failure`);
            process.exit(1);
          }
        }

        const registry = 'ghcr.io';
        const tag = `${registry}/${GIT_ORG}/${image}:latest`;
        await run(
          `docker build -t ${tag} -f docker/Dockerfile.${image}`,
          `--build-arg REGISTRY=${registry} --build-arg ORG=${GIT_ORG}`,
          `docker/`
        );
        await run(`docker push ${tag}`);

        status[image].end = Date.now();
        updateStatus();
      });

      clearInterval(intervalId);
      setDone(true);
    })();
  }, [])
  return <>
    {Object.entries(status).map(([node, {outbound}]) => {
      return <Text key={node}>
        { "{ " }{
          isDone(node) ?
            <Text><Text color={'greenBright'}>{node}</Text> {time(node)}s</Text> :
          hasStarted(node) ? 
            <Text><Text color={'blueBright'}>{node}</Text> {time(node)}s</Text> :
          /* not started case */
            <Text>{node}</Text> 
        }{ " }" }
        {outbound.length > 0 &&
          <>
            {' -> { '}
            {outbound.map((outNode, i) => {
              return <Text key={`${node}->${outNode}`}>
                {i > 0 && ', '}
                {
                  isDone(outNode) ?
                    <Text color={'greenBright'}>{outNode}</Text> :
                  hasStarted(outNode) ? 
                    <Text color={'blueBright'}>{outNode}</Text> :
                  /* not started case */
                    <Text>{outNode}</Text>
                }
              </Text>
            })}
            {' }'}
          </>
        }
      </Text>
    })}
    <Text>Total build time: {elapsed}s</Text>
    {done && <Exit />}
  </>
}
