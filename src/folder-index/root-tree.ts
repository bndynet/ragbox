import { createHash } from "node:crypto";
import path from "node:path";
import { getPageIndexPath, ROOT_TREE_FILE, atomicWriteJson } from "./manifest";
import { Manifest, RootTreeNode } from "./types";

function createDirectoryNodeId(relativePath: string): string {
  const digest = createHash("sha1").update(relativePath || ".").digest("hex");
  return `dir:${digest}`;
}

function sortTree(node: RootTreeNode): void {
  if (!node.children) {
    return;
  }

  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === "directory") {
        return -1;
      }
      if (right.type === "directory") {
        return 1;
      }
    }
    return left.title.localeCompare(right.title) || (left.path ?? "").localeCompare(right.path ?? "");
  });

  for (const child of node.children) {
    sortTree(child);
  }
}

export function generateRootTree(manifest: Manifest): RootTreeNode {
  const rootTitle = path.basename(manifest.rootDir) || manifest.rootDir;
  const root: RootTreeNode = {
    node_id: "root",
    type: "root",
    title: rootTitle,
    children: []
  };

  const directories = new Map<string, RootTreeNode>([["", root]]);

  for (const record of manifest.documents) {
    if (record.status !== "ready") {
      continue;
    }

    const parts = record.path.split("/");
    let parent = root;
    let currentRelativeDir = "";

    for (const part of parts.slice(0, -1)) {
      currentRelativeDir = currentRelativeDir ? `${currentRelativeDir}/${part}` : part;
      let directoryNode = directories.get(currentRelativeDir);

      if (!directoryNode) {
        directoryNode = {
          node_id: createDirectoryNodeId(currentRelativeDir),
          type: "directory",
          title: part,
          path: currentRelativeDir,
          children: []
        };
        directories.set(currentRelativeDir, directoryNode);
        parent.children ??= [];
        parent.children.push(directoryNode);
      }

      parent = directoryNode;
    }

    parent.children ??= [];
    parent.children.push({
      node_id: record.docId,
      type: "document",
      title: record.title,
      summary: record.summary,
      path: record.path,
      index_path: record.indexPath
    });
  }

  sortTree(root);
  return root;
}

export async function writeRootTree(rootDir: string, rootTree: RootTreeNode, outputDir?: string): Promise<void> {
  await atomicWriteJson(getPageIndexPath(rootDir, ROOT_TREE_FILE, outputDir), rootTree);
}
