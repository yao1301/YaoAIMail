import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { File, FileText, Image, FileArchive, Film, Music, Download, Loader, Check, ExternalLink, Sparkles, Bot, Presentation, FileSpreadsheet, LayoutGrid, List, Rows3, Copy, Save } from "lucide-react";
import { listAttachments, downloadAttachment, openAttachment, getAttachmentPath, getAttachmentDragIconPath, saveAttachmentsAs, copyAttachmentsToClipboard } from "@/lib/api";
import type { Attachment } from "@/lib/api";
import { sanitizeFilename } from "@/lib/sanitizeFilename";
import { useToastStore } from "@/stores/toast.store";
import { useUIStore } from "@/stores/ui.store";
import ContextMenu, { type ContextMenuItem } from "./ContextMenu";

interface Props {
  messageId: string;
}

function getMimeIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("zip") || mimeType.includes("archive") || mimeType.includes("compressed") || mimeType.includes("tar") || mimeType.includes("rar")) return FileArchive;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType.includes("csv")) return FileSpreadsheet;
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return Presentation;
  if (mimeType.includes("text") || mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("word")) return FileText;
  return File;
}

function attachmentIconColor(mimeType: string): string {
  if (mimeType.includes("pdf")) return "#d94b4b";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType.includes("csv")) return "#2e9b62";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "#d46b42";
  if (mimeType.includes("word") || mimeType.includes("document")) return "#3978c5";
  if (mimeType.startsWith("image/")) return "#9a63c7";
  return "var(--color-text-secondary)";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(err: unknown): string | null {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return null;
  const record = err as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  return null;
}

export default function AttachmentList({ messageId }: Props) {
  const { t } = useTranslation();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadedPaths, setDownloadedPaths] = useState<Record<string, string>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; attachments: Attachment[] } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<"large" | "small" | "list">("list");
  const [systemIcons, setSystemIcons] = useState<Record<string, string>>({});
  const [dragIconPath, setDragIconPath] = useState("");

  useEffect(() => {
    void getAttachmentDragIconPath().then(setDragIconPath).catch(() => {});
  }, []);

  // Listen for download progress events
  useEffect(() => {
    const unlisten = listen<{ attachment_id: string; bytes_copied: number; total_bytes: number }>(
      "attachment:download-progress",
      (event) => {
        const { attachment_id, bytes_copied, total_bytes } = event.payload;
        const pct = total_bytes > 0 ? Math.round((bytes_copied / total_bytes) * 100) : 0;
        setDownloadProgress((prev) => ({ ...prev, [attachment_id]: pct }));
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    listAttachments(messageId)
      .then((list) => {
        if (!cancelled) {
          const visible = list.filter((a) => !a.is_inline);
          setAttachments(visible);
          // Windows：读取系统关联程序图标；其他系统命令返回 null，继续使用文件类型图标。
          void Promise.all(visible.map(async (attachment) => {
            try {
              const path = await getAttachmentPath(attachment.id);
              // 未下载附件没有 local_path；Windows Shell 仍可根据文件名扩展名
              // 返回关联程序图标，因此把文件名作为后备输入传给原生命令。
              const icon = await invoke<string | null>("get_system_file_icon", { path: path || attachment.filename });
              return icon ? [attachment.id, icon] as const : null;
            } catch { return null; }
          })).then((pairs) => {
            if (cancelled) return;
            setSystemIcons(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair))));
          });
        }
      })
      .catch(() => {
        if (!cancelled) setAttachments([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [messageId]);

  async function handleDownload(attachment: Attachment) {
    setDownloadingId(attachment.id);
    try {
      const { downloadDir } = await import("@tauri-apps/api/path");
      const dir = await downloadDir();
      const safeName = sanitizeFilename(attachment.filename);
      const savePath = `${dir}/${safeName}`;
      const downloadedPath = await downloadAttachment(attachment.id, savePath);
      setDownloadedPaths((prev) => ({ ...prev, [attachment.id]: downloadedPath }));
      setDownloadProgress((prev) => { const next = { ...prev }; delete next[attachment.id]; return next; });
    } catch (err) {
      console.error("Failed to download attachment:", err);
      const reason = getErrorMessage(err);
      useToastStore.getState().addToast({
        message: reason
          ? t("attachments.downloadFailedWithReason", "Failed to download attachment: {{reason}}", { reason })
          : t("attachments.downloadFailed", "Failed to download attachment"),
        type: "error",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  async function handleOpen(attachment: Attachment) {
    try {
      await openAttachment(attachment.id);
    } catch (err) {
      const reason = getErrorMessage(err);
      useToastStore.getState().addToast({
        message: reason
          ? `无法打开附件：${reason}`
          : "无法打开附件，请先确认附件已完整下载。",
        type: "error",
      });
    }
  }

  function selectAttachment(index: number, event: React.MouseEvent) {
    const selectedRange = event.shiftKey && lastSelectedIndex !== null
      ? attachments.slice(Math.min(index, lastSelectedIndex), Math.max(index, lastSelectedIndex) + 1).map((item) => item.id)
      : [];
    const next = new Set(event.shiftKey ? selectedRange : event.ctrlKey || event.metaKey ? selectedIds : []);
    if (event.ctrlKey || event.metaKey) {
      if (next.has(attachments[index].id)) next.delete(attachments[index].id);
      else next.add(attachments[index].id);
    } else if (!event.shiftKey) next.add(attachments[index].id);
    setSelectedIds(next);
    setLastSelectedIndex(index);
  }

  function selectedAttachments(fallback?: Attachment): Attachment[] {
    const selected = attachments.filter((attachment) => selectedIds.has(attachment.id));
    return selected.length > 0 ? selected : fallback ? [fallback] : [];
  }

  async function handleCopy(items: Attachment[]) {
    try {
      await copyAttachmentsToClipboard(items.map((item) => item.id));
      useToastStore.getState().addToast({ message: `已复制 ${items.length} 个附件`, type: "success" });
    } catch (error) {
      useToastStore.getState().addToast({ message: getErrorMessage(error) || "复制附件失败，请先确认附件已下载", type: "error" });
    }
  }

  async function handleSaveAs(items: Attachment[]) {
    try {
      await saveAttachmentsAs(items.map((item) => item.id));
      useToastStore.getState().addToast({ message: `已保存 ${items.length} 个附件`, type: "success" });
    } catch (error) {
      const reason = getErrorMessage(error);
      if (reason && !reason.includes("取消")) useToastStore.getState().addToast({ message: reason, type: "error" });
    }
  }

  async function handleNativeDrag(items: Attachment[], event: React.DragEvent) {
    event.preventDefault();
    try {
      const paths = (await Promise.all(items.map((item) => getAttachmentPath(item.id))))
        .filter((path): path is string => Boolean(path));
      if (paths.length !== items.length) throw new Error("附件文件尚未完整下载");
      const icon = dragIconPath || await getAttachmentDragIconPath();
      if (!dragIconPath) setDragIconPath(icon);
      await startDrag({ item: paths, icon, mode: "copy" });
    } catch (error) {
      useToastStore.getState().addToast({ message: getErrorMessage(error) || "无法把附件拖到 Windows 文件夹", type: "error" });
    }
  }

  if (loading) return null;
  if (attachments.length === 0) return null;

  const allSelected = selectedIds.size === attachments.length && attachments.length > 0;
  const batchButtonStyle: React.CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: 4,
    background: "var(--color-bg)",
    cursor: "pointer",
    color: "var(--color-text-secondary)",
    fontSize: 11,
    padding: "3px 7px",
  };

  return (
    <div
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectedIds.size > 0) {
          event.preventDefault();
          void handleCopy(selectedAttachments());
        }
      }}
      style={{
        padding: "12px 16px",
        borderTop: "1px solid var(--color-border)",
        backgroundColor: "var(--color-bg)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "12px",
          fontWeight: "600",
          color: "var(--color-text-secondary)",
          marginBottom: "8px",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        <span>{t("attachments.title")} ({attachments.length}){selectedIds.size > 0 ? ` · 已选 ${selectedIds.size}` : ""}</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              setSelectedIds(allSelected ? new Set() : new Set(attachments.map((item) => item.id)));
              setLastSelectedIndex(null);
            }}
            title={allSelected ? "取消全选附件" : "全选附件"}
            style={batchButtonStyle}
          >
            {allSelected ? "取消全选" : "全选"}
          </button>
          {selectedIds.size > 0 && <>
            <button type="button" onClick={() => void handleCopy(selectedAttachments())} title="复制所选附件" style={batchButtonStyle}>复制</button>
            <button type="button" onClick={() => void handleSaveAs(selectedAttachments())} title="另存为所选附件" style={batchButtonStyle}>保存</button>
          </>}
        </div>
        <div style={{ display: "flex", gap: 2 }} role="group" aria-label="附件查看方式">
          {([
            ["large", LayoutGrid, "大图标"],
            ["small", Rows3, "小图标"],
            ["list", List, "列表"],
          ] as const).map(([mode, ModeIcon, label]) => (
            <button key={mode} type="button" onClick={() => setViewMode(mode)} title={label} aria-label={label} style={{ border: 0, borderRadius: 4, padding: "3px 5px", cursor: "pointer", background: viewMode === mode ? "var(--color-sidebar-active)" : "transparent", color: viewMode === mode ? "var(--color-accent)" : "var(--color-text-secondary)" }}>
              <ModeIcon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: viewMode === "large" || viewMode === "small" ? "grid" : "flex", gridTemplateColumns: viewMode === "large" ? "repeat(auto-fill, minmax(150px, 1fr))" : "repeat(auto-fill, minmax(260px, 1fr))", flexDirection: "column", gap: viewMode === "large" ? "6px" : "4px" }}>
        {attachments.map((attachment) => {
          const Icon = getMimeIcon(attachment.mime_type);
          const iconColor = attachmentIconColor(attachment.mime_type);
          const isDownloading = downloadingId === attachment.id;

          return (
            <div
              key={attachment.id}
              tabIndex={0}
              role="option"
              aria-selected={selectedIds.has(attachment.id)}
              draggable
              onDragStart={(event) => {
                const items = selectedIds.has(attachment.id) ? selectedAttachments(attachment) : [attachment];
                void handleNativeDrag(items, event);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                const items = selectedAttachments(attachment);
                setSelectedIds(new Set(items.map((item) => item.id)));
                setContextMenu({ x: event.clientX, y: event.clientY, attachments: items });
              }}
              onClick={(event) => {
                selectAttachment(attachments.indexOf(attachment), event);
                event.currentTarget.focus();
              }}
              style={{
                display: "flex",
                alignItems: viewMode === "large" ? "stretch" : "center",
                flexDirection: "row",
                gap: viewMode === "large" ? "6px" : "5px",
                padding: viewMode === "large" ? "8px" : viewMode === "small" ? "4px 6px" : "6px 8px",
                borderRadius: "6px",
                backgroundColor: selectedIds.has(attachment.id) ? "var(--color-sidebar-active)" : "var(--color-bg-hover)",
                fontSize: "13px",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: viewMode === "large" ? 44 : viewMode === "small" ? 20 : 26,
                  height: viewMode === "large" ? 44 : viewMode === "small" ? 20 : 26,
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  background: `color-mix(in srgb, ${iconColor} 14%, transparent)`,
                  color: iconColor,
                }}
                title="使用电脑默认程序打开"
              >
                {systemIcons[attachment.id] ? (
                  <img src={systemIcons[attachment.id]} alt="" draggable={false} style={{ width: viewMode === "large" ? 32 : viewMode === "small" ? 16 : 18, height: viewMode === "large" ? 32 : viewMode === "small" ? 16 : 18, objectFit: "contain" }} />
                ) : (
                  <Icon size={viewMode === "large" ? 28 : 16} />
                )}
              </span>
              <span
                onDoubleClick={() => void handleOpen(attachment)}
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--color-text-primary)",
                  cursor: "pointer",
                }}
                title="双击用电脑默认软件打开"
              >
                {attachment.filename}
              </span>
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--color-text-secondary)",
                  flexShrink: 0,
                }}
              >
                {formatFileSize(attachment.size)}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                {isDownloading && downloadProgress[attachment.id] != null && (
                  <span style={{ fontSize: "10px", color: "var(--color-accent)", minWidth: "28px", textAlign: "right" }}>
                    {downloadProgress[attachment.id]}%
                  </span>
                )}
                <button
                  onClick={() => void handleOpen(attachment)}
                  aria-label={`打开附件：${attachment.filename}`}
                  title="用电脑默认软件打开"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px",
                    borderRadius: "4px",
                    color: "var(--color-text-secondary)",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <ExternalLink size={14} />
                </button>
                <button
                  onClick={() => handleDownload(attachment)}
                  disabled={isDownloading}
                  aria-label={t("attachments.download") + ": " + attachment.filename}
                  title={isDownloading ? t("attachments.downloading") : downloadedPaths[attachment.id] ? downloadedPaths[attachment.id] : t("attachments.download")}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: isDownloading ? "default" : "pointer",
                    padding: "2px",
                    borderRadius: "4px",
                    color: "var(--color-text-secondary)",
                    display: "flex",
                    alignItems: "center",
                    opacity: isDownloading ? 0.5 : 1,
                  }}
                >
                  {isDownloading ? (
                    <Loader size={14} className="spinner" />
                  ) : downloadedPaths[attachment.id] ? (
                    <Check size={14} style={{ color: "var(--color-accent)" }} />
                  ) : (
                    <Download size={14} />
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildAttachmentMenu(contextMenu.attachments)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );

  function buildAttachmentMenu(items: Attachment[]): ContextMenuItem[] {
    const attachment = items[0];
    return [
      { label: `复制${items.length > 1 ? `（${items.length} 个）` : ""}`, icon: <Copy size={14} />, onClick: () => void handleCopy(items) },
      { label: `另存为${items.length > 1 ? `（${items.length} 个）` : ""}`, icon: <Save size={14} />, onClick: () => void handleSaveAs(items) },
      { label: "打开", icon: <ExternalLink size={14} />, onClick: () => void handleOpen(attachment) },
      { label: "下载", icon: <Download size={14} />, onClick: () => handleDownload(attachment) },
      {
        label: "发送到 AI 写作",
        icon: <Sparkles size={14} />,
        onClick: () => {
          useUIStore.getState().enqueueAiContextAttachment(attachment.id, attachment.filename);
          useUIStore.getState().openRightPanel("aiWriting");
          useToastStore.getState().addToast({ message: "已发送到 AI 写作的补充上下文", type: "success" });
        },
      },
      {
        label: "发送到 AI 开发客户",
        icon: <Sparkles size={14} />,
        onClick: () => {
          useUIStore.getState().enqueueLeadContextAttachment(attachment.id, attachment.filename);
          useUIStore.getState().setActiveView("leadFinder");
          useToastStore.getState().addToast({ message: "已发送到 AI 开发客户上下文，点击搜索即可使用", type: "success" });
        },
      },
      {
        label: "发送到首页 AI 工作台",
        icon: <Bot size={14} />,
        onClick: () => {
          useUIStore.getState().enqueueHomeContextAttachment(attachment.id, attachment.filename);
          useUIStore.getState().setActiveView("kanban");
          useToastStore.getState().addToast({ message: "已发送到首页 AI 工作台上下文", type: "success" });
        },
      },
    ];
  }
}
