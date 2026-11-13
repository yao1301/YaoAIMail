import type { LeadQuality } from '@/lib/api';
import type { ReactNode } from 'react';
import { formatResearchTimestamp, getResearchContacts, researchSourceUrl, type BuyingSignal, type EmailResearchEvidence, type ResearchContact } from '@/lib/researchEvidence';
import { EmailVerificationSelect,MailboxCheckInfo,useMailboxPresentation } from '@/components/EmailVerificationPanel';
import { useEmailChecks,emailCheckKey } from '@/stores/emailChecks.store';
import './LeadDeliveryCard.css';

export interface LeadDeliveryItem {
  companyName?: string; website?: string;
  companyIntroduction?: string; description?: string; products?: string; recommendationReason?: string; reason?: string;
  quality?: LeadQuality; fitSummary?: string; unknowns?: string[]; country?: string; city?: string; address?: string; customerType?: string;
  tags?: string[]; contactRoles?: string[];
  emails?: string[]; emailDiscoveryStatus?: string;
  emailEvidence?: EmailResearchEvidence[];
  contacts?: ResearchContact[];
  buyingSignals?: BuyingSignal[];
}

function PersonEvidence({ contact, openUrl }: { contact: ResearchContact; openUrl: (url: string) => void }) {
  const url=researchSourceUrl(contact.sourceUrl);
  const historical=contact.currentStatus==='historical';
  const observedAt=formatResearchTimestamp(contact.observedAt);
  return <details className="lead-delivery__person">
    <summary>{url ? <button type="button" className="lead-delivery__person-link" onClick={event=>{event.preventDefault();openUrl(url);}}>{contact.name}{contact.role ? ` · ${contact.role}` : ''}</button> : <strong>{contact.name}{contact.role ? ` · ${contact.role}` : ''}</strong>}
      <span className="lead-delivery__muted">{historical ? '历史人物 · 不作现任联系人' : '现职未确认 · 实际采购权未知'}</span>
      <span className="lead-delivery__email-toggle">来源证明</span>
    </summary>
    <div className="lead-delivery__person-evidence">
      <p>{url && contact.quote.trim() ? '姓名/职位有来源引用，当前任职未确认' : '姓名/职位待核实'}</p>
      {contact.quote && <p><strong>来源原文：</strong>{contact.quote}</p>}
      {url ? <button type="button" onClick={()=>openUrl(url)}>{url}</button> : <p>姓名与职位来源待补充</p>}
      {(contact.sourceDate || observedAt) && <p>{[contact.sourceDate && `来源日期：${contact.sourceDate}`,observedAt && `观察时间：${observedAt}`].filter(Boolean).join(' · ')}</p>}
      <p>{historical ? '仅作历史资料；实际采购权未知。' : '实际采购权未知'}</p>
    </div>
  </details>;
}

/** Business delivery only: no query plan, tool trace, scoring recipe or progress prose. */
function MailboxEvidenceRow({email,evidence,openUrl}:{email:string;evidence:EmailResearchEvidence[];openUrl:(url:string)=>void}){
  const first=evidence[0];
  const {presentation,screen}=useMailboxPresentation(email,evidence);
  const verifiedAt=formatResearchTimestamp(presentation.verifiedAt);
  return <details className={`lead-delivery__email${screen?.status==='invalid'?' email-screen--invalid':''}`}>
    <summary><EmailVerificationSelect email={email}/><strong className="lead-delivery__address">{email}</strong><span className="lead-delivery__email-type">{first?.emailType || '邮箱用途待确认'}</span>
      <span className="lead-delivery__evidence-kind" aria-label={`邮箱依据：${presentation.evidenceLabel}`}>{presentation.evidenceLabel}</span>
      <span className="lead-delivery__verification" aria-label={`投递验证：${presentation.deliveryLabel}`}>{presentation.deliveryLabel}</span>
      {screen && <span className={`email-screen-badge email-screen-badge--${screen.status}`}>{screen.status==='passed'?'初筛通过·仅域名':screen.status==='invalid'?'初筛不通过':'初筛待核实'}</span>}
      {presentation.warning && <span className="lead-delivery__email-warning">{presentation.warning}</span>}<span className="lead-delivery__email-toggle">详情</span>
    </summary>
    <div className="lead-delivery__judgement"><p><strong>邮箱依据：</strong>{presentation.evidenceLabel}；<strong>投递验证：</strong>{presentation.deliveryLabel}</p>
      {(presentation.verificationProvider || verifiedAt) && <p>{[presentation.verificationProvider && `验证服务：${presentation.verificationProvider}`,verifiedAt && `验证时间：${verifiedAt}`].filter(Boolean).join(' · ')}</p>}
      <MailboxCheckInfo email={email}/>
      {first?.person && !first.personName && <p>历史人员描述（待核实）：{first.person}</p>}
      <p><strong>联系建议：</strong>{presentation.contactAdvice}</p>
      {evidence.length>0 && <div className="lead-delivery__sources">{[...new Set(evidence.map(e=>researchSourceUrl(e.sourceUrl)).filter((url):url is string=>Boolean(url)))].map((url,index)=><button key={url} type="button" onClick={()=>openUrl(url)}>邮箱来源{index+1}</button>)}</div>}
    </div>
  </details>;
}

export default function LeadDeliveryCard({ item, openUrl, retryContact, selection, statusExtra, actions }: {
  item: LeadDeliveryItem; openUrl: (url: string) => void; retryContact?: () => void;
  selection?: ReactNode; statusExtra?: ReactNode; actions?: ReactNode;
}) {
  const level=item.quality?.level;
  const match=level==='source_matched'?'产品与渠道匹配':level==='channel_candidate'?'潜在采购渠道': '部分要求待确认';
  const gaps=[...new Set((item.quality?.unknowns || item.unknowns || [])
    .filter(s=>/^(用户条件待核实|偏好待核实|偏好未满足|产品限定待核实)/.test(s))
    .map(s=>s.replace(/^(用户条件待核实|偏好待核实|偏好未满足|产品限定待核实)[：:]?\s*/,'')))];
  const emails=[...new Set(item.emails || [])];
  const checks=useEmailChecks(s=>s.records);
  const rejectedEmails=emails.filter(email=>checks[emailCheckKey(email)]?.screen?.status==='invalid');
  const sources=[...new Set(item.quality?.evidence.map(p=>p.url) || [])];
  const contacts=getResearchContacts(item.contacts,item.emailEvidence);
  const people=contacts.filter(contact=>contact.currentStatus!=='historical');
  const historicalPeople=contacts.filter(contact=>contact.currentStatus==='historical');
  let domain='';try { if(item.website) domain=new URL(/^https?:\/\//i.test(item.website)?item.website:`https://${item.website}`).hostname.replace(/^www\./,''); }catch{/* The existing website action reports invalid URLs. */}
  return <article className="lead-company-card" aria-label={`${item.companyName || '客户公司'}的搜客结果`}>
    <header className="lead-company-card__header">
      {selection}
      <span className="lead-company-card__avatar" aria-hidden="true">{(item.companyName || 'C').slice(0,1).toUpperCase()}</span>
      <div className="lead-company-card__identity"><h3>{item.companyName || '客户公司'}</h3>
        <p>{[domain,item.country || '国家/地区待核实',item.city,item.customerType].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="lead-company-card__badges"><span className={`lead-delivery__match lead-delivery__match--${level || 'needs_review'}`}>{match}</span>{statusExtra}</div>
    </header>
    <div className="lead-delivery">
    <section aria-label="公司介绍"><h4>公司介绍</h4>
      <p>{item.companyIntroduction || item.description || '公开资料暂不足以形成完整介绍，请核实公司官网。'}</p>
      {item.products && <p><strong>主营业务：</strong>{item.products}</p>}
      <p><strong>地址：</strong>{item.address || '官网暂未找到可核实的公开地址'}</p>
    </section>
    <section aria-label="匹配判断"><h4>匹配判断</h4><div>
      <p>{item.recommendationReason || item.reason || item.fitSummary || '尚不能确认符合全部要求，请结合企业业务和采购需求判断。'}</p>
      {gaps.length>0 && <details className="lead-delivery__conditions"><summary>待核实 {gaps.length} 项 <span>查看条件</span></summary><ul>{gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></details>}
      </div>
    </section>
    {contacts.length>0 && <section className="lead-delivery__people" aria-label="人员来源"><h4>人员来源</h4><div>
      {people.length>0 && <p className="lead-delivery__muted">具名人员（{people.length}）；现职与实际采购权均未确认。</p>}
      {people.map((contact,index)=><PersonEvidence key={`${contact.name}-${index}`} contact={contact} openUrl={openUrl}/>)}
      {historicalPeople.length>0 && <details className="lead-delivery__historical"><summary>历史人物（{historicalPeople.length}）· 不作现任联系人</summary>
        {historicalPeople.map((contact,index)=><PersonEvidence key={`${contact.name}-${index}`} contact={contact} openUrl={openUrl}/>)}
      </details>}
    </div></section>}
    {!!item.buyingSignals?.length && <section className="lead-delivery__signals" aria-label="业务证据"><h4>业务证据</h4><div>
      <p className="lead-delivery__muted">公开业务线索，不代表采购意向。</p>
      {item.buyingSignals.map((signal,index)=>{
        const url=researchSourceUrl(signal.sourceUrl);
        const observedAt=formatResearchTimestamp(signal.observedAt);
        return <details key={`${signal.sourceUrl}-${index}`} className="lead-delivery__signal"><summary><span>{signal.summary || '业务线索待核实'}</span><span className="lead-delivery__email-toggle">证据</span></summary>
          <div className="lead-delivery__person-evidence"><p><strong>来源原文：</strong>{signal.quote || '原文待补充'}</p>
            {url ? <button type="button" onClick={()=>openUrl(url)}>{url}</button> : <p>来源待补充</p>}
            {observedAt && <p>观察时间：{observedAt}</p>}
          </div>
        </details>;
      })}
    </div></section>}
    <section className="lead-delivery__contacts" aria-label="邮箱与联系建议"><div className="lead-delivery__contacts-heading"><h4>邮箱与联系建议{emails.length>0 ? `（${emails.length}）` : ''}</h4>{emails.length>0 && <span>点击邮箱行查看完整详情</span>}</div>
      {!!item.contactRoles?.length && <p className="lead-delivery__muted">建议联系岗位：{item.contactRoles.join('、')}</p>}
      {!emails.length ? <p className="lead-delivery__empty">{item.emailDiscoveryStatus==='running'?'正在查找公开邮箱…':item.emailDiscoveryStatus==='pending'?'联系方式待补充':item.emailDiscoveryStatus==='failed'?'暂未完成邮箱核实，可重新查找。':'暂未找到可确认归属的公开邮箱。'} {retryContact && item.emailDiscoveryStatus!=='running' && <button type="button" onClick={retryContact}>重新查找邮箱</button>}</p> : emails.filter(e=>!rejectedEmails.includes(e)).map(email=><MailboxEvidenceRow key={email} email={email} evidence={item.emailEvidence?.filter(e=>emailCheckKey(e.email)===emailCheckKey(email))||[]} openUrl={openUrl}/>)}
      {!!rejectedEmails.length && <details className="lead-delivery__conditions"><summary>初筛不通过（{rejectedEmails.length}）· 展开查看原因</summary>{rejectedEmails.map(email=><MailboxEvidenceRow key={email} email={email} evidence={item.emailEvidence?.filter(e=>emailCheckKey(e.email)===emailCheckKey(email))||[]} openUrl={openUrl}/>)}</details>}
    </section>
    {!!item.tags?.length && <div className="lead-delivery__tags" aria-label="客户标签">{item.tags.map(tag=><span key={tag}>#{tag}</span>)}</div>}
    {sources.length>0 && <details className="lead-delivery__sources"><summary>公司公开资料来源（{sources.length}）</summary>{sources.map((url,index)=><button key={url} type="button" onClick={()=>openUrl(url)}>资料来源 {index+1}</button>)}</details>}
    </div>
    {actions && <footer className="lead-company-card__actions">{actions}</footer>}
  </article>;
}
