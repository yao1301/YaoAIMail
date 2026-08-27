import type { Folder } from "./ipc-types";

export interface FolderWithDepth {
  folder: Folder;
  depth: number;
}

/**
 * Convert a flat folder list into visual tree order.
 *
 * The input order is preserved among roots and among siblings, but every
 * folder's descendants are emitted immediately after that folder. This is
 * essential for an indented flat list: emitting all roots first and all
 * children afterwards makes a child look as if it belongs to the preceding
 * unrelated root.
 */
export function withFolderDepth(folders: Folder[]): FolderWithDepth[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParent = new Map<string, Folder[]>();
  const roots: Folder[] = [];

  for (const folder of folders) {
    if (!folder.parent_id || !byId.has(folder.parent_id)) {
      roots.push(folder);
      continue;
    }
    const children = childrenByParent.get(folder.parent_id) ?? [];
    children.push(folder);
    childrenByParent.set(folder.parent_id, children);
  }

  const result: FolderWithDepth[] = [];
  const visited = new Set<string>();

  const visit = (folder: Folder, depth: number) => {
    if (visited.has(folder.id)) return;
    visited.add(folder.id);
    result.push({ folder, depth });
    for (const child of childrenByParent.get(folder.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of roots) visit(root, 0);

  // Broken/cyclic parent references must not hide folders. Render each
  // remaining component once at the top level; the visited guard prevents an
  // invalid cycle from recursing forever.
  for (const folder of folders) {
    if (!visited.has(folder.id)) visit(folder, 0);
  }

  return result;
}
