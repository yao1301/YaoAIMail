import type { AssistantEvidenceReport } from '@/lib/api';

const TOOL_LABELS: Record<string, string> = {
  mail_search: '检索邮件', mail_recent: '查看邮件目录', mail_read: '读取正文', mail_thread: '展开往来',
  knowledge_search: '检索资料', knowledge_read: '读取资料', web_search: '联网搜索', fetch_url: '读取网页', gleif_company: '主体核验',
  customer_read: '读取关联客户画像',
};
export default function EvidenceReportView({ report }: { report: AssistantEvidenceReport }) {
  return <details style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-border)', fontSize: 11 }}>
    <summary style={{ cursor: 'pointer' }}>取证范围：正文 {report.readMailCount} 封，完整读取 {report.completeMailCount} 封；候选 {report.discoveredMailCount} 封（非全邮箱计数）</summary>
    {report.warnings.map(warning => <p key={warning} style={{ margin: '6px 0', color: 'var(--color-text-primary)' }}>{warning}</p>)}
    {report.resources.map(resource => <div key={`${resource.kind}:${resource.id}`} style={{ marginTop: 5 }}>
      {resource.label || '无主题'}：{resource.bodyStatus === 'headers-only' ? '正文未下载' : resource.bodyStatus === 'missing' ? '没有可用正文' : resource.complete ? '正文完整读取' : `读取 ${resource.readChars}/${resource.totalChars} 字符，尚未读完`}
    </div>)}
    {report.trace.length > 0 && <div style={{ marginTop: 7, color: 'var(--color-text-secondary)' }}>实际步骤：{report.trace.map((step, index) => `${index + 1}. ${TOOL_LABELS[step.tool] || '未授权工具'}${step.status === 'failed' ? '（失败/未执行）' : ''}`).join(' → ')}</div>}
  </details>;
}
