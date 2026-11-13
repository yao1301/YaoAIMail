import type { Folder } from "@/lib/api";

export const ALL_ACCOUNTS_SELECT_VALUE = "__all_accounts__";
export const ALL_ACCOUNTS_ID = "all";
export const ALL_ACCOUNTS_FOLDER_PREFIX = "all:";

export type FolderRole = NonNullable<Folder["role"]>;

const SYSTEM_ROLE_ORDER: FolderRole[] = ["inbox", "sent", "archive", "drafts", "trash", "spam"];

const SYSTEM_ROLE_NAMES: Record<FolderRole, string> = {
  inbox: "Inbox",
  sent: "Sent",
  archive: "Archive",
  drafts: "Drafts",
  trash: "Trash",
  spam: "Spam",
};

export function allAccountsFolderId(role: FolderRole): string {
  return `${ALL_ACCOUNTS_FOLDER_PREFIX}${role}`;
}

export function isAllAccountsFolderId(folderId: string | null | undefined): boolean {
  return !!folderId && folderId.startsWith(ALL_ACCOUNTS_FOLDER_PREFIX);
}

export function roleFromAllAccountsFolderId(folderId: string | null | undefined): FolderRole | null {
  if (!folderId || !isAllAccountsFolderId(folderId)) return null;
  const role = folderId.slice(ALL_ACCOUNTS_FOLDER_PREFIX.length);
  return SYSTEM_ROLE_ORDER.includes(role as FolderRole) ? role as FolderRole : null;
}

export function buildAllAccountsFolders(folders: Folder[]): Folder[] {
  const roles = new Set(folders.map((folder) => folder.role).filter(Boolean) as FolderRole[]);
  const virtualFolders = SYSTEM_ROLE_ORDER
    .filter((role) => roles.has(role))
    .map((role, index): Folder => ({
      id: allAccountsFolderId(role),
      account_id: ALL_ACCOUNTS_ID,
      remote_id: allAccountsFolderId(role),
      name: SYSTEM_ROLE_NAMES[role],
      folder_type: "folder",
      role,
      parent_id: null,
      color: null,
      is_system: true,
      sort_order: index,
    }));

  const customFolders = folders
    .filter((folder) => !folder.role)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  return [...virtualFolders, ...customFolders];
}

export function sortFoldersForSidebar(folders: Folder[]): Folder[] {
  const firstFolderByRole = new Map<FolderRole, Folder>();
  const customFolders: Folder[] = [];

  for (const folder of folders) {
    if (!folder.role) {
      customFolders.push(folder);
      continue;
    }
    if (!firstFolderByRole.has(folder.role)) {
      firstFolderByRole.set(folder.role, folder);
    }
  }

  const systemFolders = SYSTEM_ROLE_ORDER.flatMap((role) => {
    const folder = firstFolderByRole.get(role);
    return folder ? [folder] : [];
  });

  return [
    ...systemFolders,
    ...customFolders.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
  ];
}

export function folderIdsForSelection(folderId: string | null, folders: Folder[]): string[] {
  if (!folderId) return [];
  // 全部账号虚拟文件夹（如"所有未读"）：跨账号按 role 聚合
  const allRole = roleFromAllAccountsFolderId(folderId);
  if (allRole) {
    return folders.filter((folder) => folder.role === allRole).map((folder) => folder.id);
  }
  // 具体账号的真实文件夹：只看它自己，不跨账号合并同 role 文件夹
  // （否则点击账号 A 的收件箱会混入账号 B 的收件箱）
  return folders.some((folder) => folder.id === folderId) ? [folderId] : [];
}

export function roleForSelection(folderId: string | null, folders: Folder[]): Folder["role"] {
  return roleFromAllAccountsFolderId(folderId) ?? folders.find((folder) => folder.id === folderId)?.role ?? null;
}

export function unreadCountForFolder(
  folderId: string,
  folders: Folder[],
  countsByFolderId: Record<string, number>,
): number {
  const matchingFolderIds = folderIdsForSelection(folderId, folders);
  return matchingFolderIds.reduce((sum, id) => sum + (countsByFolderId[id] ?? 0), 0);
}

/**
 * The “All unread” entry represents every non-spam folder, matching the
 * unread total shown beside each account. It must not be limited to Inbox:
 * unread mail can live in Archive or user-created folders too.
 */
export function unreadCountForAllUnread(
  folders: Folder[],
  countsByFolderId: Record<string, number>,
): number {
  return folders.reduce(
    (sum, folder) => sum + (folder.role === "spam" ? 0 : (countsByFolderId[folder.id] ?? 0)),
    0,
  );
}
