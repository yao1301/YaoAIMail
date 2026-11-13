import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useRef } from "react";
import { Pencil, Send, Sparkles, Trash2, Upload } from "lucide-react";
import {
  deleteKnowledgeItem,
  listKnowledgeItems,
  saveKnowledgeItem,
  type KnowledgeItem,
  type KnowledgeSnippet,
  searchKnowledgeBase,
  agentRun,
  aiPrompt,
} from "@/lib/api";
import { useToastStore } from "@/stores/toast.store";
import { SettingsFeedback, type SettingsNotice } from "./SettingsFeedback";
import { useMailStore } from "@/stores/mail.store";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { extractDocumentText } from "@/lib/documentText";
import AccountScopeSelect from "@/components/AccountScopeSelect";
import { useUIStore } from "@/stores/ui.store";
import MarkdownView from "@/lib/renderMarkdown";

const SUPPORTED_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm", ".xml", ".docx", ".xlsx", ".xls", ".pdf"];

export default function KnowledgeBaseTab() {
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const enqueueKnowledgeContext = useUIStore((state) => state.enqueueKnowledgeContext);
  const setActiveView = useUIStore((state) => state.setActiveView);
  const openRightPanel = useUIStore((state) => state.openRightPanel);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useWorkspaceState<KnowledgeItem[]>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:items", []);
  const [editingId, setEditingId] = useWorkspaceState<string | undefined>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:editingId");
  const [name, setName] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:name", "");
  const [content, setContent] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:content", "");
  const [sourceType, setSourceType] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:sourceType", "note");
  const [scopeAccountIds, setScopeAccountIds] = useWorkspaceState<string[] | null>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:scopeAccountIds", null);
  const [saving, setSaving] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:saving", false);
  const [searchQuery, setSearchQuery] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:searchQuery", "");
  const [searchResults, setSearchResults] = useWorkspaceState<KnowledgeSnippet[]>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:searchResults", []);
  const [knowledgeAnswer, setKnowledgeAnswer] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:knowledgeAnswer", "");
  const [questionBusy, setQuestionBusy] = useWorkspaceState("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:questionBusy", false);
  const [marketingBusyId, setMarketingBusyId] = useWorkspaceState<string | null>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:marketingBusyId", null);
  const [contextMenu, setContextMenu] = useWorkspaceState<{ x: number; y: number; item: KnowledgeItem } | null>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:contextMenu", null);
  const [feedback, setFeedback] = useWorkspaceState<Record<string, SettingsNotice | undefined>>("src/features/settings/KnowledgeBaseTab.tsx:KnowledgeBaseTab:feedback", {});
  const addToast = useToastStore((state) => state.addToast);

  function showFeedback(action: string, message?: string, kind: SettingsNotice["kind"] = "error") {
    setFeedback((current) => ({ ...current, [action]: message ? { message, kind } : undefined }));
  }

  async function refresh() {
    // 管理页展示全部资料，适用账号由每份资料自己的范围决定。
    setItems(await listKnowledgeItems(null));
  }

  useWorkspaceInitEffect("src/features/settings/KnowledgeBaseTab.tsx:", () => {
    refresh().catch((error) => {
      addToast({ message: `读取资料库失败：${extractErrorMessage(error)}`, type: "error" });
    });
  }, [addToast]);

  function resetEditor() {
    showFeedback("save");
    showFeedback("file");
    setEditingId(undefined);
    setName("");
    setContent("");
    setSourceType("note");
    setScopeAccountIds(null);
  }

  async function handleSave() {
    setSaving(true);
    showFeedback("save");
    try {
      await saveKnowledgeItem({ id: editingId, name, content, sourceType, accountIds: scopeAccountIds ?? [] });
      await refresh();
      resetEditor();
      showFeedback("save", "资料已保存到本地资料库。", "success");
    } catch (error) {
      showFeedback("save", `保存失败：${extractErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleFile(file: File) {
    showFeedback("file");
    const lower = file.name.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      showFeedback("file", "请选择 TXT、Markdown、CSV、JSON、HTML、XML、Word DOCX、Excel XLS/XLSX 或带文字层的 PDF。");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      showFeedback("file", "文件过大，请控制在 25 MB 以内。");
      return;
    }
    const extracted = (await extractDocumentText(file)).trim();
    if (!extracted) {
      throw new Error("没有提取到可搜索文字；扫描版 PDF 需要 OCR，当前版本暂不支持。");
    }
    setEditingId(undefined);
    setName(file.name);
    setSourceType("file");
    setContent(extracted);
  }

  async function runKnowledgeQuestion() {
    const question = searchQuery.trim();
    if (!question || questionBusy) return;
    showFeedback("question");
    setQuestionBusy(true);
    setKnowledgeAnswer("");
    try {
      const snippets = await searchKnowledgeBase(question, 8, activeAccountId);
      setSearchResults(snippets);
      const evidence = snippets.map((snippet) => `资料：${snippet.name}\n位置：${snippet.locator || snippet.section || "未标注"}\n内容：${snippet.content}`).join("\n\n---\n\n");
      const answer = await aiPrompt(
        "你是本地产品资料问答助手。只依据用户资料库中提供的片段回答，不要补充资料中没有的参数、价格、认证、交期或承诺。资料不足时明确说资料库没有找到，并告诉用户需要补充什么。用中文回答，先给结论，再列出依据和资料位置。不要输出原始 Markdown 标记。",
        `用户问题：${question}\n\n资料库命中片段：\n${evidence || "（没有检索到匹配片段）"}`,
      );
      setKnowledgeAnswer(answer.trim() || "资料库没有返回可用答案。");
    } catch (error) {
      showFeedback("question", `资料问答失败：${extractErrorMessage(error)}`);
    } finally {
      setQuestionBusy(false);
    }
  }

  async function generateMarketing(item: KnowledgeItem) {
    const approved = window.confirm(`将“${item.name}”中最多 6,000 字的相关内容发送给当前配置的 AI 服务商，用于生成营销素材。不会发送其他资料，是否继续？`);
    if (!approved) return;
    const action = `item:${item.id}`;
    showFeedback(action);
    setMarketingBusyId(item.id);
    try {
      const result = await agentRun(
        "你是外贸产品营销助手。只能依据用户明确提供的产品资料生成营销素材，不得猜测参数、认证、价格或产能。输出中文，包含：核心卖点、目标客户与应用场景、英文产品简介、3个开发信切入点、FAQ、需要用户补充核实的信息。",
        `资料名称：${item.name}\n资料片段：\n${item.content.slice(0, 6000)}`,
      );
      await saveKnowledgeItem({ name: `${item.name} · AI营销素材`, content: result.content, sourceType: "marketing", accountIds: item.accountIds ?? (item.accountId ? [item.accountId] : []) });
      await refresh();
      showFeedback(action, "营销素材已生成并保存，可继续编辑。", "success");
    } catch (error) {
      showFeedback(action, `生成失败：${extractErrorMessage(error)}`);
    } finally { setMarketingBusyId(null); }
  }

  async function removeItem(item: KnowledgeItem) {
    const action = `item:${item.id}`;
    showFeedback(action);
    try {
      await deleteKnowledgeItem(item.id);
      await refresh();
    } catch (error) {
      showFeedback(action, `删除资料失败：${extractErrorMessage(error)}`);
    }
  }

  return (
    <div>
      <h2 style={{ margin: "0 0 8px", fontSize: "18px" }}>产品与资料中心</h2>
      <p style={{ margin: "0 0 18px", color: "var(--color-text-secondary)", fontSize: "13px", lineHeight: 1.55 }}>
        文档会在本地自动分块并建立混合检索索引。PDF 保留页码，Excel 保留工作表位置；AI 只引用命中的少量片段，并可显示资料名称和位置。
      </p>

      <div style={questionBox}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 5 }}>向产品与资料中心提问</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8 }}>用完整问题描述你想知道的内容，AI 会引用本地资料片段并标出页码或工作表位置。</div>
        <div style={questionComposer}>
          <textarea value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runKnowledgeQuestion(); } }} placeholder="例如：我们这款产品有哪些功率和认证？付款方式、交期分别是什么？" rows={4} style={questionInput} />
          <button type="button" onClick={() => void runKnowledgeQuestion()} disabled={questionBusy || !searchQuery.trim()} style={{ ...sendButton, opacity: questionBusy || !searchQuery.trim() ? 0.55 : 1 }}><Send size={14} />{questionBusy ? "回答中" : "提问"}</button>
        </div>
        <SettingsFeedback notice={feedback.question} />
        <div style={{ marginTop: 6, fontSize: 11, color: "var(--color-text-secondary)" }}>Enter 提问 · Shift + Enter 换行 · 只使用当前邮箱账号可用的资料</div>
      </div>
      {knowledgeAnswer && <div style={answerBox}><div style={{ fontWeight: 700, marginBottom: 7 }}>资料中心回答</div><MarkdownView text={knowledgeAnswer} /></div>}
      {searchResults.length > 0 && <div style={{ display: "grid", gap: 7, marginBottom: 16 }}>
        {searchResults.map((snippet) => <div key={`${snippet.id}-${snippet.chunkId}`} style={{ padding: 9, border: "1px solid var(--color-border)", borderRadius: 7, fontSize: 12 }}>
          <strong>{snippet.name}</strong><span style={{ marginLeft: 7, color: "var(--color-accent)" }}>{snippet.locator}{snippet.section ? ` · ${snippet.section}` : ""}</span>
          <div style={{ marginTop: 4, color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", maxHeight: 80, overflow: "hidden" }}>{snippet.content}</div>
        </div>)}
      </div>}

      <div style={importBox}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>导入资料</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>新建文字资料，或导入 Word、Excel、PDF 等文件。资料会保存在本地并建立检索索引。</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={() => fileRef.current?.click()} style={buttonStyle}><Upload size={14} />选择文件</button>
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.docx,.xlsx,.xls,.pdf,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style={{ display: "none" }} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void handleFile(file).catch((error) => showFeedback("file", `文件解析失败：${extractErrorMessage(error)}`)); }} />
        </div>
        <SettingsFeedback notice={feedback.file} />
        <AccountScopeSelect value={scopeAccountIds} onChange={setScopeAccountIds} label="这份资料可以给哪些邮箱账号使用？" />
        <input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="资料名称，例如：付款与报价规则" style={inputStyle} />
        <textarea value={content} onChange={(event) => setContent(event.currentTarget.value)} placeholder="粘贴或输入资料内容…" style={{ ...inputStyle, minHeight: "180px", resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" disabled={saving || !name.trim() || !content.trim()} onClick={handleSave} style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: saving || !name.trim() || !content.trim() ? 0.6 : 1 }}>
            {saving ? "正在保存…" : editingId ? "保存修改" : "加入资料库"}
          </button>
          {(editingId || name || content) && <button type="button" onClick={resetEditor} style={buttonStyle}>取消</button>}
        </div>
        <SettingsFeedback notice={feedback.save} />
      </div>

      <h3 style={{ fontSize: "14px", marginBottom: "10px" }}>已有资料（{items.length}）</h3>
      {items.length === 0 ? (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--color-text-secondary)", border: "1px dashed var(--color-border)", borderRadius: "8px" }}>
          还没有资料。可以先加入公司介绍、产品参数或常用条款。
        </div>
      ) : items.map((item) => (
        <div key={item.id} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, item }); }} style={{ padding: "12px", border: "1px solid var(--color-border)", borderRadius: "8px", marginBottom: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <strong style={{ fontSize: "13px", flex: 1 }}>{item.name}</strong>
            <span style={{ fontSize: "11px", color: "var(--color-accent)" }}>{item.accountIds?.length ? `指定 ${item.accountIds.length} 个账号` : "全部账号共享"}</span>
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{item.sourceType === "file" ? "导入文件" : "文字资料"}</span>
            <span style={{ fontSize: "11px", color: "var(--color-text-secondary)" }}>{item.chunks?.length || 0} 个片段</span>
            <button type="button" title="基于所选资料生成营销素材" disabled={marketingBusyId === item.id} onClick={() => void generateMarketing(item)} style={iconButtonStyle}><Sparkles size={14} /></button>
            <button type="button" title="编辑" onClick={() => { setEditingId(item.id); setName(item.name); setContent(item.content); setSourceType(item.sourceType); setScopeAccountIds(item.accountIds ?? (item.accountId ? [item.accountId] : null)); }} style={iconButtonStyle}><Pencil size={14} /></button>
            <button type="button" title="删除" onClick={() => void removeItem(item)} style={{ ...iconButtonStyle, color: "#dc3545" }}><Trash2 size={14} /></button>
          </div>
          <SettingsFeedback notice={feedback[`item:${item.id}`]} />
          <div style={{ marginTop: "8px", color: "var(--color-text-secondary)", fontSize: "12px", lineHeight: 1.5, whiteSpace: "pre-wrap", maxHeight: "72px", overflow: "hidden" }}>
            {item.content.slice(0, 260)}
          </div>
        </div>
      ))}
      {contextMenu && <div onMouseLeave={() => setContextMenu(null)} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, zIndex: 200, minWidth: 190, padding: 5, border: "1px solid var(--color-border)", borderRadius: 8, background: "var(--color-bg-primary)", boxShadow: "0 8px 24px rgba(0,0,0,.2)" }}>
        <div style={{ padding: "5px 8px", fontSize: 11, color: "var(--color-text-secondary)" }}>发送“{contextMenu.item.name}”到</div>
        <button type="button" onClick={() => { enqueueKnowledgeContext(contextMenu.item.id, contextMenu.item.name, "writing"); openRightPanel("aiWriting"); setContextMenu(null); }} style={menuButton}>AI 写作</button>
        <button type="button" onClick={() => { enqueueKnowledgeContext(contextMenu.item.id, contextMenu.item.name, "compose"); setActiveView("compose"); setContextMenu(null); }} style={menuButton}>写信草稿指令框</button>
        <button type="button" onClick={() => { enqueueKnowledgeContext(contextMenu.item.id, contextMenu.item.name, "leadFinder"); setActiveView("leadFinder"); setContextMenu(null); }} style={menuButton}>AI 开发客户</button>
        <button type="button" onClick={() => { enqueueKnowledgeContext(contextMenu.item.id, contextMenu.item.name, "home"); setActiveView("kanban"); setContextMenu(null); }} style={menuButton}>首页 AI 工作台</button>
      </div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  background: "var(--color-bg)",
  color: "var(--color-text-primary)",
  fontSize: "13px",
};

const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "7px 12px",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  background: "var(--color-bg)",
  color: "var(--color-text-primary)",
  cursor: "pointer",
  fontSize: "12px",
};

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  padding: "5px",
  border: "none",
  borderRadius: "4px",
  background: "transparent",
  color: "var(--color-text-secondary)",
  cursor: "pointer",
};

const menuButton: React.CSSProperties = {
  display: "block",
  width: "100%",
  border: 0,
  borderRadius: 5,
  padding: "7px 8px",
  background: "transparent",
  color: "var(--color-text-primary)",
  textAlign: "left",
  cursor: "pointer",
  fontSize: 12,
};

const questionBox: React.CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 14,
  marginBottom: 12,
  border: "2px solid var(--color-accent)",
  borderRadius: 10,
  background: "color-mix(in srgb, var(--color-accent) 4%, var(--color-bg-primary))",
};

const questionComposer: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-end",
  padding: 9,
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  background: "var(--color-bg-primary)",
};

const questionInput: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 84,
  maxHeight: 260,
  resize: "none",
  border: 0,
  outline: 0,
  background: "transparent",
  color: "var(--color-text-primary)",
  fontFamily: "inherit",
  fontSize: 13,
  lineHeight: 1.6,
};

const sendButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: 0,
  borderRadius: 7,
  padding: "8px 12px",
  background: "var(--color-accent)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

const answerBox: React.CSSProperties = {
  padding: "12px 14px",
  marginBottom: 14,
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  background: "var(--color-bg-secondary)",
  color: "var(--color-text-primary)",
  fontSize: 13,
  lineHeight: 1.6,
};

const importBox: React.CSSProperties = {
  display: "grid",
  gap: 10,
  padding: 14,
  marginBottom: 20,
  border: "1px solid var(--color-border)",
  borderRadius: 8,
};
