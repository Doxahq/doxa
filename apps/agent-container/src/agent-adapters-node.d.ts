declare module "@doxahq/agent/adapters/node" {
  interface NodeWorkspaceAdapter {
    readonly root?: string;
  }

  interface NodeArtifactStore {
    readonly __brand?: "NodeArtifactStore";
  }

  export function createNodeWorkspaceAdapter(root: string): NodeWorkspaceAdapter;
  export function createNodeArtifactStore(root: string): NodeArtifactStore;
}
