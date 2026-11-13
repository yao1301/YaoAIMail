import { useWorkspaceState, useWorkspaceInitEffect, useWorkspaceScope } from '@/lib/workspaceState';
import { useCallback, useEffect, useRef } from "react";
import { readAttachmentFile } from "@/lib/api";
import { readDraftDocuments } from "@/features/compose/documentDraft";

export type AiInputFile = { id: string; file: File };

/** Some WebViews expose a dropped/pasted file only through DataTransfer.items. */
export function filesFromTransfer(transfer: DataTransfer): File[] {
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).flatMap(item => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/** Shared intake and complete-read boundary for every AI instruction box. */
export function useAiFileContext(scopeKey: string) {
  const [files, setFiles] = useWorkspaceState<AiInputFile[]>("src/hooks/useAiFileContext.ts:useAiFileContext:files", []);
  const filesRef = useRef(files);
  const [pending, setPending] = useWorkspaceState("src/hooks/useAiFileContext.ts:useAiFileContext:pending", false);
  const [error, setError] = useWorkspaceState("src/hooks/useAiFileContext.ts:useAiFileContext:error", "");
  const [status, setStatus] = useWorkspaceState("src/hooks/useAiFileContext.ts:useAiFileContext:status", "");
  const intakeError = useRef("");
  const pendingCount = useRef(0);
  const epoch = useRef(0);
  const scope = useRef(scopeKey);
  scope.current = scopeKey;
  const workspace = useWorkspaceScope();
  filesRef.current = files;
  const mounted = useRef(true);
  const clear = useCallback(() => {
    epoch.current += 1; filesRef.current = []; pendingCount.current = 0; intakeError.current = "";
    setFiles([]); setPending(false); setError(""); setStatus("");
  }, []);
  useWorkspaceInitEffect('src/hooks/useAiFileContext.ts:', () => { clear(); }, [scopeKey, clear]);
  useEffect(() => { mounted.current = true; return () => { if (!workspace?.moved) { mounted.current = false; epoch.current += 1; } }; }, []);
  const fail = useCallback((message: string) => {
    intakeError.current = message; setError(message); setStatus("");
  }, []);
  const add = useCallback((incoming: FileList | File[], preserveError = false) => {
    try {
      const next = [...filesRef.current];
      for (const file of Array.from(incoming)) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`文件“${file.name}”超过 20 MB，请拆分后重新添加。`);
        const id = `${file.name}-${file.size}-${file.lastModified}`;
        if (!next.some(item => item.id === id)) next.push({ id, file });
      }
      if (next.length > 12) throw new Error("一次最多添加 12 个文件，请减少文件后重新添加；没有只保留前几个文件。");
      filesRef.current = next; setFiles(next); setStatus("");
      if (!preserveError) { intakeError.current = ""; setError(""); }
    } catch (problem) { fail(String(problem instanceof Error ? problem.message : problem)); }
  }, [fail]);
  const remove = useCallback((id: string) => {
    filesRef.current = filesRef.current.filter(item => item.id !== id);
    setFiles(filesRef.current); intakeError.current = ""; setError(""); setStatus("");
  }, []);
  const loadAttachment = useCallback((id: string) => {
    const expectedScope = scope.current, generation = epoch.current;
    const current = () => mounted.current && scope.current === expectedScope && epoch.current === generation;
    pendingCount.current += 1; setPending(true);
    void readAttachmentFile(id).then(attachment => {
      if (current()) add([new File([new Uint8Array(attachment.bytes)], attachment.name, { type: attachment.mime_type || "" })], true);
    }).catch(() => { if (current()) fail("读取拖入文件失败，请重新添加该文件后再继续。"); })
      .finally(() => { if (current()) { pendingCount.current = Math.max(0, pendingCount.current - 1); setPending(pendingCount.current > 0); } });
  }, [add, fail]);
  const read = useCallback(async () => {
    if (pendingCount.current > 0) throw new Error("文件正在加载，请稍后再继续。");
    if (intakeError.current) throw new Error(intakeError.current);
    const generation = epoch.current, expectedScope = scope.current;
    const snapshot = [...filesRef.current];
    const current = () => mounted.current && generation === epoch.current && expectedScope === scope.current;
    setError(""); setStatus(snapshot.length ? `正在读取 ${snapshot.length} 个文件…` : "");
    try {
      const sections = await readDraftDocuments(snapshot.map(item => item.file));
      if (!current()) throw new Error("文件所属的账户或任务已切换，本次读取结果未使用。");
      setStatus(sections.length ? `已读取 ${sections.length} 个文件` : "");
      return sections.map((section, index) => ({ ...section, id: snapshot[index].id }));
    } catch (problem) {
      if (current()) { setError(problem instanceof Error ? problem.message : String(problem)); setStatus(""); }
      throw problem;
    }
  }, []);
  return { files, pending, error, status, add, remove, clear, fail, loadAttachment, read };
}
