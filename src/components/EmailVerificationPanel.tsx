import { createContext,useContext,useEffect,useMemo,useState,type ReactNode } from 'react';
import { getExternalServiceKeyStatus,recordResearchEmailFeedback,type ResearchFeedbackKind } from '@/lib/api';
import { useEmailChecks,emailCheckKey,refreshEmailFeedback } from '@/stores/emailChecks.store';
import { listen } from '@tauri-apps/api/event';
import { useMailStore } from '@/stores/mail.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { useUIStore } from '@/stores/ui.store';
import { formatResearchTimestamp,getEmailEvidencePresentation,type EmailResearchEvidence } from '@/lib/researchEvidence';
import './EmailVerificationPanel.css';

const Scope=createContext<{selected:Set<string>;toggle:(email:string)=>void}|null>(null);
export function EmailVerificationScope({emails,children}:{emails:string[];children:ReactNode}){
  const signature=JSON.stringify([...new Set(emails.map(emailCheckKey))].sort());
  const unique=useMemo(()=>JSON.parse(signature) as string[],[signature]);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [configured,setConfigured]=useState<boolean|null>(null);
  const records=useEmailChecks(s=>s.records),screening=useEmailChecks(s=>s.screening),busy=useEmailChecks(s=>s.busy);
  const progress=useEmailChecks(s=>s.progress),error=useEmailChecks(s=>s.error);
  useEffect(()=>{void useEmailChecks.getState().screen(unique);},[signature]); // Native cache decides freshness; no model or paid call.
  useEffect(()=>{const subscription=listen('research:email-feedback',()=>{void refreshEmailFeedback(unique).catch(()=>{});}).catch(()=>()=>{});return()=>{void subscription.then(stop=>stop());};},[signature]);
  useEffect(()=>{setSelected(old=>new Set([...old].filter(e=>unique.includes(e))));},[signature]);
  useEffect(()=>{let alive=true;void (async()=>{try{const status=await getExternalServiceKeyStatus();if(alive)setConfigured(status.hunterConfigured);}catch{if(alive)setConfigured(false);}})();return()=>{alive=false;};},[]);
  const eligible=unique.filter(e=>records[e]?.screen?.status!=='invalid' && records[e]?.feedback?.kind!=='unsubscribe');
  async function verify(targets:string[]){
    const wanted=[...new Set(targets)].filter(e=>eligible.includes(e));
    if(!wanted.length)return;
    // Re-read status after an in-place key configuration, never read the key itself.
    const status=await getExternalServiceKeyStatus().catch(()=>null);
    setConfigured(status?.hunterConfigured??false);
    if(!status?.hunterConfigured)return;
    const repeats=wanted.filter(e=>records[e]?.verification).length;
    const yes=await useConfirmStore.getState().confirm({title:'确认手动验证邮箱',message:`将把选中的 ${wanted.length} 个邮箱发送给Hunter，最多逐个调用 ${wanted.length} 次。${repeats?`其中 ${repeats} 个有历史结果，将重新验证。`:''}可能消耗免费或付费额度，具体以Hunter账户为准；验证通过也不保证最终送达。`,confirmLabel:'开始验证'});
    if(yes)await useEmailChecks.getState().verify(wanted,repeats>0);
  }
  return <Scope.Provider value={{selected,toggle:email=>setSelected(old=>{const next=new Set(old);const key=emailCheckKey(email);if(next.has(key))next.delete(key);else next.add(key);return next;})}}>
    {unique.length>0 && <section className="email-checks-panel" aria-label="邮箱初筛与手动验证">
      <div className="email-checks-panel__actions"><strong>邮箱检查</strong>
        <span>{screening?'正在免费初筛…':`共 ${unique.length} 个 · 初筛不通过 ${unique.length-eligible.length} 个`}</span>
        <button type="button" disabled={busy || !eligible.length} onClick={()=>setSelected(new Set(eligible))}>全选可验证邮箱</button>
        <button type="button" disabled={busy || !selected.size} onClick={()=>void verify([...selected])}>验证选中（{selected.size}）</button>
        <button type="button" disabled={busy || !eligible.length} onClick={()=>void verify(eligible)}>验证本页全部（{eligible.length}）</button>
        {busy && <button type="button" onClick={()=>useEmailChecks.getState().stop()}>停止验证</button>}
        {configured===false && <button type="button" onClick={()=>{useUIStore.getState().setSettingsTab('externalServices');useUIStore.getState().setActiveView('settings');}}>配置Hunter</button>}
      </div>
      <p>基础初筛仅检查格式和域名收信记录，不用Hunter额度；DNS只查询域名，不上传完整邮箱。具体邮箱存在性仍需验证。</p>
      {configured===false && <p>未配置Hunter：仍可免费初筛；手动投递验证需先填写自己的Hunter API Key。</p>}
      {progress && <p role="status">{progress}</p>}{error && <p role="alert">{error}</p>}
    </section>}
    {children}
  </Scope.Provider>;
}
export function EmailVerificationSelect({email}:{email:string}){
  const scope=useContext(Scope);const busy=useEmailChecks(s=>s.busy);
  const blocked=useEmailChecks(s=>s.records[emailCheckKey(email)]?.screen?.status==='invalid'||s.records[emailCheckKey(email)]?.feedback?.kind==='unsubscribe');
  if(!scope)return null;
  return <input type="checkbox" aria-label={`选择验证 ${email}`} checked={scope.selected.has(emailCheckKey(email))} disabled={busy||blocked} onClick={e=>e.stopPropagation()} onChange={()=>scope.toggle(email)}/>;
}
export function useMailboxPresentation(email:string,evidence:EmailResearchEvidence[]){
  const row=useEmailChecks(s=>s.records[emailCheckKey(email)]);
  const latest=row?.verification;
  const current=latest ? evidence.map(e=>(e.verifiedAt||0)>latest.checkedAt || (e.verificationProvider && !/hunter/i.test(e.verificationProvider)) ? e : {...e,deliveryStatus:undefined,verifiedAt:undefined,verificationProvider:undefined}) : evidence;
  const presentation=getEmailEvidencePresentation(latest ? [...current,{email,source:'',sourceUrl:'',verification:latest.reason,deliveryStatus:latest.deliveryStatus,verificationProvider:latest.verificationProvider}] : evidence);
  return {presentation,screen:row?.screen,verification:latest};
}
export function MailboxCheckInfo({email}:{email:string}){
  const row=useEmailChecks(s=>s.records[emailCheckKey(email)]);
  const [error,setError]=useState('');
  const [saving,setSaving]=useState(false);
  const labels:Record<ResearchFeedbackKind,string>={replied:'已回复',hard_bounce:'永久退信',soft_bounce:'临时退信',unsubscribe:'对方已退订',cleared:'已解除联系限制'};
  async function record(kind:ResearchFeedbackKind){
    const yes=await useConfirmStore.getState().confirm({title:'记录实际联系结果',message:`将 ${email} 记录为“${labels[kind]}”。这是人工反馈，不会把服务器接受发送当成实际送达。${kind==='unsubscribe'?'后续自动开发将停止联系此邮箱。':''}`,confirmLabel:'保存记录'});
    if(!yes)return;
    setSaving(true);setError('');
    try{const feedback=await recordResearchEmailFeedback(email,kind);useEmailChecks.setState(s=>({records:{...s.records,[emailCheckKey(email)]:{...s.records[emailCheckKey(email)],feedback}}}));}
    catch{setError('反馈保存失败，请重试');}finally{setSaving(false);}
  }
  return <div className="email-checks-detail">
    {row?.screen && <p><strong>{row.screen.status==='passed'?'初筛通过（非投递验证）':row.screen.status==='invalid'?'初筛不通过':'初筛未能确认'}</strong>：{row.screen.reason}</p>}
    {row?.verification && <p>Hunter：{row.verification.reason} · 查询时间：{formatResearchTimestamp(row.verification.checkedAt)}{row.verification.providerDate?` · 服务记录日期：${row.verification.providerDate}`:''}</p>}
    {row?.feedback && <p>{row.feedback.source==='automatic'?'自动识别':'人工反馈'}：{labels[row.feedback.kind]} · {formatResearchTimestamp(row.feedback.recordedAt)}
      {row.feedback.reason && <span> · {row.feedback.reason}</span>}
      {row.feedback.sourceMessageId && row.feedback.accountId && <button type="button" onClick={()=>{useMailStore.getState().setActiveAccountId(row.feedback!.accountId!);useUIStore.getState().openMessageInInbox(row.feedback!.sourceMessageId!);useUIStore.getState().setMessageDetailId(row.feedback!.sourceMessageId!);useUIStore.getState().setActiveView('messageDetail');}}>查看依据邮件</button>}
    </p>}
    <label>联系结果：<select aria-label={`记录联系结果 ${email}`} disabled={saving} value="" onChange={e=>{if(e.target.value)void record(e.target.value as ResearchFeedbackKind);}}><option value="">记录实际结果…</option>{Object.entries(labels).map(([kind,label])=><option key={kind} value={kind}>{label}</option>)}</select></label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
