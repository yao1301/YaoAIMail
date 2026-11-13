export type SettingsNotice = { message: string; kind: "error" | "success" };

export function SettingsFeedback({ notice }: { notice?: SettingsNotice | null }) {
  if (!notice) return null;
  const error = notice.kind === "error";
  return (
    <div role={error ? "alert" : "status"} style={{
      marginTop: 8,
      padding: "8px 11px",
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.5,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      background: error ? "rgba(220, 53, 69, 0.1)" : "var(--color-bg-hover)",
      color: error ? "var(--color-error, #dc3545)" : "var(--color-text-primary)",
      border: `1px solid ${error ? "rgba(220, 53, 69, 0.3)" : "var(--color-border)"}`,
    }}>
      {notice.message}
    </div>
  );
}
