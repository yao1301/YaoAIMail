import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FolderInput, Loader2, Upload, X } from "lucide-react";
import { listFolders, type Folder } from "@/lib/api";
import { useAccountsQuery } from "@/hooks/queries";
import { useToastStore } from "@/stores/toast.store";
import { queryClient } from "@/lib/query-client";

interface ImportProgress {
  taskId: string;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  currentFile: string;
}

interface ImportReport extends Omit<ImportProgress, "currentFile"> {
  cancelled: boolean;
  errors: string[];
}

function makeTaskId() {
  return `mail-import-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function MailImportSection() {
  const { data: accounts = [] } = useAccountsQuery();
  const [accountId, setAccountId] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [lastReport, setLastReport] = useState<ImportReport | null>(null);
  const addToast = useToastStore((state) => state.addToast);

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  useEffect(() => {
    if (!accountId) {
      setFolders([]);
      setFolderId("");
      return;
    }
    let active = true;
    listFolders(accountId).then((items) => {
      if (!active) return;
      const usable = items.filter((folder) => folder.role !== "trash" && folder.role !== "spam");
      setFolders(usable);
      setFolderId((current) => usable.some((folder) => folder.id === current)
        ? current
        : (usable.find((folder) => folder.role === "inbox") ?? usable[0])?.id ?? "");
    }).catch(() => {
      if (active) setFolders([]);
    });
    return () => { active = false; };
  }, [accountId]);

  useEffect(() => {
    const unlisten = listen<ImportProgress>("mail-import-progress", (event) => {
      if (event.payload.taskId === taskId) setProgress(event.payload);
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [taskId]);

  const selectedLabel = useMemo(() => {
    if (paths.length === 0) return "尚未选择邮件文件";
    if (paths.length === 1) return paths[0];
    return `已选择 ${paths.length} 个文件或文件夹`;
  }, [paths]);

  async function chooseFiles() {
    const selected = await invoke<string[]>("choose_mail_import_files");
    if (selected.length) setPaths(selected);
  }

  async function chooseFolder() {
    const selected = await invoke<string | null>("choose_eml_import_folder");
    if (selected) setPaths([selected]);
  }

  async function startImport() {
    if (!accountId || !folderId || paths.length === 0 || taskId) return;
    const nextTaskId = makeTaskId();
    setTaskId(nextTaskId);
    setLastReport(null);
    setProgress({ taskId: nextTaskId, processed: 0, imported: 0, skipped: 0, failed: 0, currentFile: "正在准备…" });
    try {
      const report = await invoke<ImportReport>("import_mail_files", {
        taskId: nextTaskId,
        accountId,
        folderId,
        paths,
      });
      setLastReport(report);
      setPaths([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["messages"] }),
        queryClient.invalidateQueries({ queryKey: ["folder-unread-counts"] }),
        queryClient.invalidateQueries({ queryKey: ["folder-counts"] }),
      ]);
      addToast({
        type: report.cancelled ? "error" : "success",
        duration: 10_000,
        message: report.cancelled
          ? `导入已取消：已导入 ${report.imported} 封，跳过重复 ${report.skipped} 封`
          : `导入完成：成功 ${report.imported} 封，跳过重复 ${report.skipped} 封，失败 ${report.failed} 封`,
      });
    } catch (error) {
      addToast({ type: "error", duration: 10_000, message: `邮件导入失败：${String(error)}` });
    } finally {
      setTaskId(null);
    }
  }

  return (
    <section style={{ marginTop: "32px", paddingTop: "24px", borderTop: "1px solid var(--color-border)" }}>
      <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>从其他邮件软件迁移</h3>
      <p style={{ fontSize: "12px", lineHeight: 1.6, color: "var(--color-text-secondary)", margin: "0 0 14px" }}>
        批量导入 EML 或 MBOX，正文、HTML、附件和原始日期都会保留。也可选择一个包含大量 EML 的文件夹，系统会递归扫描、分批导入并自动跳过相同 Message-ID 的邮件。
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr)", gap: "10px" }}>
        <label style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
          导入到邮箱账户
          <select value={accountId} disabled={Boolean(taskId)} onChange={(event) => setAccountId(event.target.value)} style={{ display: "block", width: "100%", marginTop: "5px", padding: "8px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-primary)" }}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name || account.email}（{account.email}）</option>)}
          </select>
        </label>
        <label style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>
          目标邮件夹
          <select value={folderId} disabled={Boolean(taskId)} onChange={(event) => setFolderId(event.target.value)} style={{ display: "block", width: "100%", marginTop: "5px", padding: "8px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-primary)" }}>
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
        <button type="button" disabled={Boolean(taskId)} onClick={() => void chooseFiles()} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-primary)", cursor: taskId ? "not-allowed" : "pointer" }}><Upload size={14} />选择 EML / MBOX 文件</button>
        <button type="button" disabled={Boolean(taskId)} onClick={() => void chooseFolder()} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", border: "1px solid var(--color-border)", borderRadius: "6px", background: "var(--color-bg)", color: "var(--color-text-primary)", cursor: taskId ? "not-allowed" : "pointer" }}><FolderInput size={14} />选择 EML 文件夹</button>
      </div>
      <div title={selectedLabel} style={{ marginTop: "9px", padding: "8px 10px", borderRadius: "6px", background: "var(--color-bg-secondary)", color: "var(--color-text-secondary)", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedLabel}</div>

      {taskId && progress && (
        <div role="status" style={{ marginTop: "12px", padding: "11px", border: "1px solid var(--color-border)", borderRadius: "7px", background: "var(--color-bg-secondary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}><Loader2 size={14} className="spin" />正在导入：{progress.currentFile}</div>
          <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--color-text-secondary)" }}>已处理 {progress.processed} 封 · 成功 {progress.imported} · 重复 {progress.skipped} · 失败 {progress.failed}</div>
          <button type="button" onClick={() => void invoke("cancel_mail_import", { taskId })} style={{ display: "flex", alignItems: "center", gap: "5px", marginTop: "9px", padding: "6px 11px", border: "1px solid var(--color-error, #dc2626)", borderRadius: "6px", background: "transparent", color: "var(--color-error, #dc2626)", cursor: "pointer" }}><X size={13} />取消导入</button>
        </div>
      )}

      {!taskId && paths.length > 0 && (
        <button type="button" disabled={!accountId || !folderId} onClick={() => void startImport()} style={{ marginTop: "12px", padding: "8px 18px", border: "none", borderRadius: "6px", background: "var(--color-accent)", color: "#fff", cursor: accountId && folderId ? "pointer" : "not-allowed" }}>开始批量导入</button>
      )}
      {lastReport && lastReport.errors.length > 0 && (
        <details style={{ marginTop: "10px", fontSize: "12px", color: "var(--color-text-secondary)" }}>
          <summary>查看失败清单（最多显示 100 条）</summary>
          <div style={{ marginTop: "6px", whiteSpace: "pre-wrap" }}>{lastReport.errors.join("\n")}</div>
        </details>
      )}
      <p style={{ fontSize: "11px", lineHeight: 1.55, color: "var(--color-text-secondary)", margin: "10px 0 0" }}>
        Foxmail 7.x 的 Storage、Account.rec0 与旧版 BOX/IDX 属于专有格式。本版不读取或破解其中保存的密码；建议先从 Foxmail 导出为 EML，再用这里批量导入。后续可在取得可靠格式样本后增加“扫描 Foxmail 数据目录”。
      </p>
    </section>
  );
}
