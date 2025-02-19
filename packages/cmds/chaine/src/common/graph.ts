class GraphNode {
  private id: string;
  private dependencies: Map<string, GraphNode>;
  private dependencyOf: Map<string, GraphNode>;
  public constructor(id: string) {
    this.id = id;
    this.dependencies = new Map();
    this.dependencyOf = new Map();
  }
  public addDependency(on: GraphNode) {
    this.dependencies.set(on.id, on);
    on.dependencyOf.set(this.id, this);
  }
  public removeDependency(on: GraphNode) {
    this.dependencies.delete(on.id);
    on.dependencyOf.delete(this.id);
  }
  public getDependencies() {
    return Array.from(this.dependencies.keys());
  }
  public getDependenciesOf() {
    return Array.from(this.dependencyOf.keys());
  }
}

export class Graph {
  private nodes: Record<string, GraphNode>;
  /**
   * @param edgeMap map from node to list of nodes that have edges which go to the key node
   */
  public static fromEdgeMap(edgeMap: Record<string, string[]>): Graph {
    const graph = new Graph();
    for (const node in edgeMap) {
      graph.addNode(node);
    }
    for (const node in edgeMap) {
      const dependencies = edgeMap[node];
      for (const dependency of dependencies) {
        graph.addEdge(dependency, node);
      }
    }
    return graph;
  }
  public constructor() {
    this.nodes = {};
  }
  public addNode(id: string) {
    if (this.hasNode(id)) {
      throw new Error(`id '${id}' already present in graph`);
    }
    this.nodes[id] = new GraphNode(id);
  }
  public hasNode(id: string) {
    return id in this.nodes;
  }
  private getById(id: string) {
    if (!(this.hasNode(id))) {
      throw new Error(`id '${id}' does not exist in graph`);
    }
    return this.nodes[id];
  }
  public addEdge(from: string, to: string) {
    const fromNode = this.getById(from);
    const toNode = this.getById(to);
    toNode.addDependency(fromNode);
  }
  public removeEdge(from: string, to: string) {
    const fromNode = this.getById(from);
    const toNode = this.getById(to);
    toNode.removeDependency(fromNode);
  }
  public getDependencies(id: string): string[] {
    return this.getById(id).getDependencies();
  }
  public getNodesDependentOn(id: string): string[] {
    return this.getById(id).getDependenciesOf();
  }
  public getNodes(): string[] {
    return Object.keys(this.nodes);
  }
  public clone(): Graph {
    const nodes = this.getNodes();
    const newGraph = new Graph();
    for (const node of nodes) {
      newGraph.addNode(node);
    }
    for (const node of nodes) {
      const existing = this.getById(node);
      for (const dependency of existing.getDependencies()) {
        newGraph.addEdge(dependency, node);
      }
    }
    return newGraph;
  }
}