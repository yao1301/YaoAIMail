import { useState } from "react";
import { aiPrompt } from "@/lib/api";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";
import MarkdownView from "@/lib/renderMarkdown";
import { resizeAutoGrowTextarea } from "@/lib/autoGrowTextarea";

const ASSISTANT_SYSTEM = `你是外贸业务员的 AI 业务助手。
根据用户当前指令完成分析、整理、回答、拟定行动方案或提取待办。
资料不足时明确说明，禁止猜测价格、订单、交期、付款或客户承诺。
不要生成完整邮件草稿；所有邮件写作统一由“AI 写作”处理。
回答使用用户指令的语言，简洁、可执行。`;

export default function AIAssistantTab({ quick: _quick = false }: { quick?: boolean }) {
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);

  async function runInstruction() {
    const command = instruction.trim();
    if (!command) return;
    setRunning(true);
    setResult("");
    try {
      const answer = await aiPrompt(
        ASSISTANT_SYSTEM,
        `【用户指令——最高优先级】\n${command}`,
      );
      setResult(answer.trim());
    } catch (error) {
      useToastStore.getState().addToast({
        message: `AI 业务助手执行失败：${extractErrorMessage(error)}`,
        type: "error",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 8px", color: "var(--color-text-primary)" }}>
        AI 业务助手
      </h2>
      <p style={{ fontSize: "12px", color: "var(--color-text-secondary)", margin: "0 0 12px" }}>
        直接下达指令；写邮件、选择收件人和生成回复统一在“AI 写作”中完成。
      </p>
      <textarea
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        onInput={(event) => resizeAutoGrowTextarea(event.currentTarget, 300)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void runInstruction();
          }
        }}
        placeholder="例如：帮我整理今天最重要的三件外贸业务事项。"
        style={{
          width: "100%",
            minHeight: "72px",
            maxHeight: "300px",
            resize: "none",
          boxSizing: "border-box",
          padding: "10px 12px",
          border: "1px solid var(--color-border)",
          borderRadius: "7px",
          background: "var(--color-bg-secondary)",
          color: "var(--color-text-primary)",
          font: "inherit",
          lineHeight: 1.6,
        }}
      />
      <button
        type="button"
        disabled={running || !instruction.trim()}
        onClick={() => void runInstruction()}
        style={{
          marginTop: "10px",
          padding: "8px 18px",
          border: "none",
          borderRadius: "6px",
          background: "var(--color-accent)",
          color: "#fff",
          cursor: running ? "default" : "pointer",
          opacity: running ? 0.65 : 1,
        }}
      >
        {running ? "正在执行…" : "执行指令"}
      </button>
      {result && (
        <div style={{
          margin: "14px 0 0",
          padding: "12px",
          maxHeight: "440px",
          overflow: "auto",
          borderRadius: "7px",
          background: "var(--color-bg-secondary)",
        }}>
          <MarkdownView text={result} />
        </div>
      )}
    </div>
  );
}
