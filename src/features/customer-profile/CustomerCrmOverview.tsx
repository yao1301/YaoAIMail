import { CalendarClock, Flag, Mail, Tags } from 'lucide-react';
import type { CustomerMemory, SearchHit } from '@/lib/api';

export const CUSTOMER_STAGES = ['待开发', '已联系', '已报价', '已寄样', '谈判中', '已成交', '流失'];
const FEATURES = ['价格敏感', '质量优先', '交期紧急', '需要认证', '定制需求', '要过样品', '长期合作', '有竞品关系'];
export function localDateValue(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
type Customer = Pick<CustomerMemory, 'company' | 'email' | 'stage' | 'status' | 'source' | 'tags' | 'tier' | 'summary' | 'nextFollowUp' | 'followUps'>;
export default function CustomerCrmOverview({ customer, mail, onChange, onShowActivity, planSummary }: {
  customer: Customer;
  mail: SearchHit[];
  onChange: (change: Partial<Customer>) => void;
  onShowActivity: () => void;
  planSummary?: string;
}) {
  const latest = [
    ...mail.map(m => ({ id: m.message_id, date: (m.date ?? 0) * 1000, note: m.subject || '无主题邮件', channel: '邮件' })),
    ...customer.followUps.map(f => ({ id: f.id, date: f.date, note: f.note, channel: f.channel })),
  ].sort((a, b) => b.date - a.date)[0];
  const overdue = customer.nextFollowUp > 0 && customer.nextFollowUp < new Date().setHours(0, 0, 0, 0);
  const stage = customer.stage || customer.status;
  return <section className="crm-overview" aria-label="客户状态总览">
    <div className="crm-overview__identity"><span>{customer.company || '公司信息待补充'}</span><span>{customer.email || '尚未填写邮箱'}</span>{customer.source && <span className="crm-muted">来源：{customer.source}</span>}</div>
    <div className="crm-overview__stats">
      <div><label><Flag size={14}/>当前阶段</label><strong>{stage || '未设置阶段'}</strong></div>
      <div><label htmlFor="crm-tier">客户分层</label><select id="crm-tier" aria-label="客户分层" value={customer.tier} onChange={e => onChange({ tier: e.target.value })}><option value="">未分层</option><option value="A">重点客户</option><option value="B">常规客户</option><option value="C">培育客户</option>{customer.tier && !['A','B','C'].includes(customer.tier) && <option value={customer.tier}>{customer.tier}</option>}</select></div>
      <div className={overdue ? 'crm-overdue' : ''}><label htmlFor="crm-next-follow"><CalendarClock size={14}/>{overdue ? '跟进已逾期' : '下次跟进'}</label><input id="crm-next-follow" aria-label="下次跟进日期" type="date" value={localDateValue(customer.nextFollowUp)} onChange={e => onChange({ nextFollowUp: e.target.value ? new Date(`${e.target.value}T00:00:00`).getTime() : 0 })}/>{planSummary && <span className="crm-plan-summary">{planSummary}</span>}</div>
      <div><label><Mail size={14}/>最近互动</label>{latest ? <button className="crm-latest" onClick={onShowActivity} title={latest.note}><strong>{new Date(latest.date).toLocaleDateString()} · {latest.channel}</strong><span>{latest.note}</span></button> : <span className="crm-muted">暂无往来记录</span>}</div>
    </div>
    <div className="crm-pipeline" role="group" aria-label="跟进阶段">
      {CUSTOMER_STAGES.map((value, index) => <button key={value} type="button" aria-pressed={customer.stage === value} className={customer.stage === value ? 'is-current' : ''} onClick={() => onChange({ stage: value })}><span>{index + 1}</span>{value}</button>)}
    </div>
    <div className="crm-traits"><h3><Tags size={14}/>客户特点</h3><div className="crm-traits__selected">{customer.tags.length ? customer.tags.map(tag => <span key={tag}>{tag}</span>) : <span className="crm-muted">尚未标记特点，不根据零散信息猜测</span>}</div><details><summary>编辑特点</summary><div className="crm-traits__options">{Array.from(new Set([...FEATURES, ...customer.tags])).map(tag => <button key={tag} type="button" aria-pressed={customer.tags.includes(tag)} onClick={() => onChange({ tags: customer.tags.includes(tag) ? customer.tags.filter(t => t !== tag) : [...customer.tags, tag] })}>{tag}</button>)}</div></details></div>
    {customer.summary && <p className="crm-overview__summary">{customer.summary}</p>}
  </section>;
}
