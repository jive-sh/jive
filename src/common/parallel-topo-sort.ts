import type { Graph } from "./graph";

function assert(condition: boolean, errMsg: string) {
  if (!condition) {
    throw new Error(errMsg);
  }
}

export type ParallelTopologicalSortResult = {
  finished: string[];
  unstarted: string[];
  errored: Record<string, string>;
}

// Based on https://github.com/diogofcunha/fast-graph/blob/master/src/index.ts#L192
// This should really be its own library
export async function parallelTopologicalSort(
  originalGraph: Graph,
  task: (entry: string) => Promise<void>): Promise<ParallelTopologicalSortResult> {
  const graph = originalGraph.clone();

  // 2. Kahn's Algorithm Traversal
  // 2.1 Initial no in edge Nodes
  const ordered = [];
  const nodesWithNoDependencies = new Set<string>();
  for (const node of graph.getNodes()) {
    if (graph.getDependencies(node).length === 0) {
      nodesWithNoDependencies.add(node);
    }
  }

  const finished: string[] = [];
  const errored: Record<string, string> = {};
  let inProgress = 0;

  // 2.2 traverse the graph
  async function iterate(finish: () => void) {
    if (nodesWithNoDependencies.size === 0 && inProgress === 0) {
      finish();
      return;
    }
    while (nodesWithNoDependencies.size > 0) {
      const first = Array.from(nodesWithNoDependencies)[0];
      nodesWithNoDependencies.delete(first)
      ordered.push(first);
      const dependencies = graph.getDependencies(first);
      assert(
        dependencies.length === 0,
        `Node '${first}' has dependencies ${dependencies.join(',')} yet was in the no dependencies graph`
      );
      (async () => {
        inProgress++;
        try {
          await task(first);
          finished.push(first);
          for (const to of graph.getNodesDependentOn(first)) {
            graph.removeEdge(first, to);
            if (graph.getDependencies(to).length === 0) {
              nodesWithNoDependencies.add(to);
            }
          }
        } catch (e) {
          const error = e as Error;
          errored[first] = error.toString();
        }
        inProgress--;
        iterate(finish);
      })();
    }
  }

  return new Promise(resolve => {
    iterate(() => {
      const erroredOrFinished: Record<string, true> = {};
      for (const errNode in errored) {
        erroredOrFinished[errNode] = true;
      }
      finished.forEach(doneNode => { erroredOrFinished[doneNode] = true; });
      const unstarted = Object.keys(graph)
        .filter(node => !(node in erroredOrFinished));
      resolve({
        finished,
        unstarted,
        errored
      });
    });
  })
}
