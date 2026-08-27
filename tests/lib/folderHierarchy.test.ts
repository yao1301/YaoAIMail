import { describe, expect, it } from "vitest";
import { withFolderDepth } from "../../src/lib/folderHierarchy";
import type { Folder } from "../../src/lib/ipc-types";

function folder(id: string, parentId: string | null, sortOrder: number): Folder {
  return {
    id,
    account_id: "account-1",
    remote_id: parentId ? `${parentId}/${id}` : id,
    name: parentId ? `${parentId}/${id}` : id,
    folder_type: "folder",
    role: null,
    parent_id: parentId,
    color: null,
    is_system: false,
    sort_order: sortOrder,
  };
}

describe("withFolderDepth", () => {
  it("places a child immediately after its real parent, before the next root", () => {
    const rsg = folder("RSG", null, 100);
    const wash = folder("WASH GEC", null, 100);
    const catchAll = folder("Catch-All", "RSG", 100);

    expect(withFolderDepth([rsg, wash, catchAll]).map(({ folder: item, depth }) => [item.id, depth]))
      .toEqual([
        ["RSG", 0],
        ["Catch-All", 1],
        ["WASH GEC", 0],
      ]);
  });

  it("uses depth-first tree order for multiple nested levels", () => {
    const rootA = folder("A", null, 1);
    const rootB = folder("B", null, 2);
    const childA = folder("A-1", "A", 1);
    const grandchildA = folder("A-1-1", "A-1", 1);
    const childB = folder("B-1", "B", 1);

    expect(withFolderDepth([rootA, rootB, childA, childB, grandchildA]).map(({ folder: item, depth }) => [item.id, depth]))
      .toEqual([
        ["A", 0],
        ["A-1", 1],
        ["A-1-1", 2],
        ["B", 0],
        ["B-1", 1],
      ]);
  });

  it("keeps orphaned and cyclic folders visible exactly once", () => {
    const orphan = folder("orphan", "missing", 1);
    const cycleA = folder("cycle-a", "cycle-b", 2);
    const cycleB = folder("cycle-b", "cycle-a", 3);

    const result = withFolderDepth([orphan, cycleA, cycleB]);
    expect(result.map(({ folder: item }) => item.id).sort())
      .toEqual(["cycle-a", "cycle-b", "orphan"]);
    expect(new Set(result.map(({ folder: item }) => item.id)).size).toBe(3);
  });
});
