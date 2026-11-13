import { useWorkspaceState, useWorkspaceInitEffect } from '@/lib/workspaceState';
import { useTranslation } from "react-i18next";
import {
  listCustomerMemories,
  saveCustomerMemory,
  deleteCustomerMemory,
  buildCustomerMemory,
  type CustomerMemory,
} from "../../lib/api";
import { useToastStore } from "@/stores/toast.store";
import MarkdownView from "@/lib/renderMarkdown";
import { extractErrorMessage } from "../../lib/extractErrorMessage";

export default function CustomerMemoryTab() {
  const { t } = useTranslation();
  const [memories, setMemories] = useWorkspaceState<CustomerMemory[]>("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:memories", []);
  const [email, setEmail] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:email", "");
  const [building, setBuilding] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:building", false);

  const [editing, setEditing] = useWorkspaceState<CustomerMemory | null>("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:editing", null);
  const [editName, setEditName] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:editName", "");
  const [editCompany, setEditCompany] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:editCompany", "");
  const [editSummary, setEditSummary] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:editSummary", "");
  const [editProfile, setEditProfile] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:editProfile", "");
  const [saving, setSaving] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:saving", false);

  const [statusMsg, setStatusMsg] = useWorkspaceState("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:statusMsg", "");
  const [statusType, setStatusType] = useWorkspaceState<"success" | "error" | "">("src/features/settings/CustomerMemoryTab.tsx:CustomerMemoryTab:statusType", "");

  function flash(msg: string, type: "success" | "error") {
    setStatusMsg(msg);
    setStatusType(type);
  }

  async function refresh() {
    try {
      setMemories(await listCustomerMemories());
    } catch (err) {
      console.error("Failed to load customer memories:", err);
    }
  }

  useWorkspaceInitEffect("src/features/settings/CustomerMemoryTab.tsx:", () => {
    refresh();
  }, []);

  async function handleBuild() {
    const e = email.trim();
    if (!e) {
      flash(t("customerMemory.noEmail"), "error");
      return;
    }
    setBuilding(true);
    try {
      const mem = await buildCustomerMemory(e, 30);
      await refresh();
      flash(t("customerMemory.buildDone", { email: mem.email }), "success");
      setEmail("");
    } catch (err: unknown) {
      const m = extractErrorMessage(err);
      flash(t("customerMemory.buildFailed", { error: m }), "error");
      useToastStore.getState().addToast({ message: t("customerMemory.buildFailed", { error: m }), type: "error" });
    } finally {
      setBuilding(false);
    }
  }

  function startEdit(m: CustomerMemory) {
    setEditing(m);
    setEditName(m.name);
    setEditCompany(m.company);
    setEditSummary(m.summary);
    setEditProfile(m.profile);
  }

  function cancelEdit() {
    setEditing(null);
    setEditName("");
    setEditCompany("");
    setEditSummary("");
    setEditProfile("");
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await saveCustomerMemory({
        id: editing.id,
        email: editing.email,
        name: editName,
        company: editCompany,
        summary: editSummary,
        profile: editProfile,
      });
      cancelEdit();
      await refresh();
      flash(t("translate.configSaved"), "success");
    } catch (err: unknown) {
      const m = extractErrorMessage(err);
      flash(t("customerMemory.saveFailed", { error: m }), "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(m: CustomerMemory) {
    try {
      setMemories(await deleteCustomerMemory(m.id));
      flash(t("customerMemory.deleted", { email: m.email }), "success");
    } catch (err: unknown) {
      const m = extractErrorMessage(err);
      flash(t("customerMemory.saveFailed", { error: m }), "error");
    }
  }

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "12px",
    fontWeight: 500,
    color: "var(--color-text-secondary)",
    marginBottom: "4px",
  };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    fontSize: "13px",
    border: "1px solid var(--color-border)",
    borderRadius: "6px",
    background: "var(--color-bg-secondary)",
    color: "var(--color-text-primary)",
    boxSizing: "border-box",
  };
  const buttonStyle: React.CSSProperties = {
    padding: "8px 18px",
    fontSize: "13px",
    fontWeight: 500,
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
  };
  const sectionStyle: React.CSSProperties = {
    marginBottom: "28px",
    paddingBottom: "20px",
    borderBottom: "1px solid var(--color-border)",
  };

  return (
    <div>
      <h2 style={{ fontSize: "18px", fontWeight: 600, color: "var(--color-text-primary)", marginTop: 0, marginBottom: "8px" }}>
        {t("customerMemory.engineTitle")}
      </h2>
      <p style={{ fontSize: "13px", color: "var(--color-text-secondary)", marginTop: 0, marginBottom: "20px" }}>
        {t("customerMemory.intro")}
      </p>

      {/* Build */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>{t("customerMemory.buildTitle")}</h3>
        <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
          {t("customerMemory.buildHint")}
        </p>
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>{t("customerMemory.emailLabel")}</label>
            <input
              style={inputStyle}
              value={email}
              placeholder="customer@company.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button
            type="button"
            disabled={building}
            onClick={handleBuild}
            style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff", opacity: building ? 0.6 : 1 }}
          >
            {building ? t("customerMemory.building") : t("customerMemory.buildButton")}
          </button>
        </div>
      </div>

      {/* List */}
      <div style={sectionStyle}>
        <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 8px" }}>{t("customerMemory.listTitle")}</h3>
        {memories.length === 0 && (
          <div style={{ fontSize: "13px", color: "var(--color-text-secondary)" }}>{t("customerMemory.noMemories")}</div>
        )}
        {memories.map((m) => (
          <div
            key={m.id}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "8px",
              padding: "12px",
              marginBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "13px" }}>{m.name || m.company || m.email}</strong>
              {m.company && m.name && <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{m.company}</span>}
              <span style={{ fontSize: "12px", color: "var(--color-text-secondary)" }}>{m.email}</span>
            </div>
            <div style={{ fontSize: "12px", color: "var(--color-text-secondary)", marginBottom: "6px" }}>
              {t("customerMemory.messageCount", { count: m.messageCount })}
            </div>
            {m.contacts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                {m.contacts.map((contact) => (
                  <span
                    key={contact.email}
                    title={contact.email}
                    style={{ fontSize: "11px", padding: "3px 7px", borderRadius: "10px", background: "var(--color-bg-hover)" }}
                  >
                    {contact.name || contact.email}{contact.jobTitle ? ` · ${contact.jobTitle}` : ""}
                  </span>
                ))}
              </div>
            )}
            <div style={{ fontSize: "12px", marginBottom: "8px" }}>{m.summary}</div>
            <div style={{
              background: "var(--color-bg-secondary)",
              padding: "10px",
              borderRadius: "6px",
              maxHeight: "160px",
              overflowY: "auto",
              margin: "0 0 10px",
            }}>
              <MarkdownView text={m.profile} />
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" style={{ ...buttonStyle, background: "var(--color-bg-hover)", color: "var(--color-text-primary)" }} onClick={() => startEdit(m)}>
                {t("customerMemory.edit")}
              </button>
              <button type="button" style={{ ...buttonStyle, background: "rgba(220,53,69,0.12)", color: "#dc3545" }} onClick={() => handleDelete(m)}>
                {t("customerMemory.delete")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Edit form */}
      {editing && (
        <div style={sectionStyle}>
          <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 12px" }}>{t("customerMemory.editTitle")}</h3>
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>{t("customerMemory.name")}</label>
            <input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>{t("customerMemory.company")}</label>
            <input style={inputStyle} value={editCompany} onChange={(e) => setEditCompany(e.target.value)} />
          </div>
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>{t("customerMemory.summary")}</label>
            <input style={inputStyle} value={editSummary} onChange={(e) => setEditSummary(e.target.value)} />
          </div>
          <div style={{ marginBottom: "14px" }}>
            <label style={labelStyle}>{t("customerMemory.profile")}</label>
            <textarea style={{ ...inputStyle, minHeight: "160px", resize: "vertical", fontFamily: "inherit" }} value={editProfile} onChange={(e) => setEditProfile(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" disabled={saving} style={{ ...buttonStyle, background: "var(--color-accent)", color: "#fff" }} onClick={handleSaveEdit}>
              {saving ? t("common.saving") : t("customerMemory.save")}
            </button>
            <button type="button" style={{ ...buttonStyle, background: "var(--color-bg-hover)", color: "var(--color-text-primary)" }} onClick={cancelEdit}>
              {t("customerMemory.cancel")}
            </button>
          </div>
        </div>
      )}

      {statusMsg && (
        <div
          role={statusType === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{
            marginTop: "14px",
            padding: "10px 14px",
            borderRadius: "6px",
            fontSize: "13px",
            background: statusType === "success" ? "var(--color-bg-hover)" : "rgba(220, 53, 69, 0.1)",
            color: statusType === "success" ? "var(--color-text-primary)" : "#dc3545",
            border: `1px solid ${statusType === "success" ? "var(--color-border)" : "rgba(220, 53, 69, 0.3)"}`,
          }}
        >
          {statusMsg}
        </div>
      )}
    </div>
  );
}
