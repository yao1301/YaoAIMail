import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { previewWorkbenchMailtoDrafts, commitWorkbenchDrafts, scheduleWorkbenchDraft, cancelWorkbenchSchedule,
  getMessage, listAttachments, checkSendGuard, updateMessageFlags, archiveMessage, listFolders, moveToFolder,
  type WorkbenchDraftPreview, type WorkbenchDraftReceipt, type WorkbenchDraftItem, type Message, type Attachment, type SendGuardVerdict } from '@/lib/api';
import { useComposeStore } from '@/stores/compose.store';
import { loadMessageForEditing } from '@/features/compose/reopenMessage';
import { useMailStore } from '@/stores/mail.store';
import { useUIStore } from '@/stores/ui.store';
import { extractErrorMessage } from '@/lib/extractErrorMessage';
import type { WorkbenchAction } from './workbenchTask';

export type WorkbenchSchedule = {draftId:string;operationId:string;sendAt:number};
type Props = {
  accountId:string;sourceMessages:{id:string;title:string}[];requestId:string;action:WorkbenchAction;initialContent?:string;
  initialReceipts?:WorkbenchDraftReceipt[];initialSchedules?:WorkbenchSchedule[];
  onCompleted?:(receipts:WorkbenchDraftReceipt[])=>void;
  onScheduled?:(schedule:WorkbenchSchedule)=>void;onCancelled?:(operationId:string)=>void;
};
const field:React.CSSProperties={padding:'7px 9px',border:'1px solid var(--color-border)',borderRadius:5,background:'var(--color-bg)',color:'var(--color-text-primary)',width:'100%',boxSizing:'border-box'};
const button:React.CSSProperties={padding:'7px 11px',border:'1px solid var(--color-border)',borderRadius:5,background:'var(--color-bg)',color:'var(--color-text-primary)',cursor:'pointer'};
const splitAddresses=(s:string)=>s.split(/[,;，；\n]/).map(s=>s.trim()).filter(Boolean);
const labels:Record<WorkbenchAction,string>={extractDrafts:'拆分邮件并保存草稿',saveDraft:'保存邮件草稿',organize:'整理选定邮件',schedule:'定时发送草稿'};

export default function WorkbenchActions(props:Props){
  const {accountId,sourceMessages,requestId,action}=props;
  const query=useQueryClient();
  const context=`${accountId}:${requestId}:${action}:${sourceMessages.map(s=>s.id).join(',')}`;
  const active=useRef(context);active.current=context;
  const locked=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [source,setSource]=useState(sourceMessages.length===1?sourceMessages[0].id:'');
  const [preview,setPreview]=useState<WorkbenchDraftPreview|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [receipts,setReceipts]=useState(props.initialReceipts??[]);
  const [schedules,setSchedules]=useState(props.initialSchedules??[]);
  const [to,setTo]=useState(''),[cc,setCc]=useState(''),[bcc,setBcc]=useState(''),[subject,setSubject]=useState(''),[body,setBody]=useState(props.initialContent??'');
  const [target,setTarget]=useState(''),[draft,setDraft]=useState<Message|null>(null),[attachments,setAttachments]=useState<Attachment[]>([]);
  const [time,setTime]=useState(''),[guard,setGuard]=useState<SendGuardVerdict|null>(null),[riskAccepted,setRiskAccepted]=useState(false);
  const [operation,setOperation]=useState('read'),[confirmed,setConfirmed]=useState(false);
  const [scheduleConfirmed,setScheduleConfirmed]=useState(false);

  useEffect(()=>{
    locked.current=false;setBusy(false);setError('');setNotice('');setPreview(null);setSelected(new Set());
    setSource(sourceMessages.length===1?sourceMessages[0].id:'');setReceipts(props.initialReceipts??[]);setSchedules(props.initialSchedules??[]);
    setDraft(null);setTarget('');setAttachments([]);setGuard(null);setTime('');setConfirmed(false);setScheduleConfirmed(false);setRiskAccepted(false);
    setTo('');setCc('');setBcc('');setSubject('');setBody(props.initialContent??'');
    return()=>{active.current='unmounted';};
  },[context]);

  async function run(work:(current:()=>boolean)=>Promise<void>){
    if(locked.current)return;locked.current=true;setBusy(true);setError('');setNotice('');const token=context;
    const current=()=>active.current===token;
    try{await work(current);}catch(e){if(current())setError(extractErrorMessage(e));}
    finally{if(current()){locked.current=false;setBusy(false);}}
  }
  async function refresh(){await Promise.all(['messages','message','folders','folder-unread-counts','pendingMailOpsList','pendingMailOps'].map(key=>query.invalidateQueries({queryKey:[key]})));}
  function toggle(key:string){setSelected(old=>{const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;});setConfirmed(false);}

  function prepare(){void run(async current=>{
    if(!source)throw new Error('请选择本次处理的来源邮件，不会把多份名单自动混在一起。');
    const result=await previewWorkbenchMailtoDrafts(accountId,source);if(!current())return;
    setPreview(result);setSelected(new Set(result.items.map(i=>i.key)));setConfirmed(false);
  });}
  function save(){void run(async current=>{
    if(!confirmed)throw new Error('请先核对并勾选确认。');
    const items:WorkbenchDraftItem[]=action==='extractDrafts'?(preview?.items.filter(i=>selected.has(i.key))??[]):[
      {key:'generated-1',to:splitAddresses(to),cc:splitAddresses(cc),bcc:splitAddresses(bcc),subject,bodyText:body}];
    if(!items.length||items.length>200)throw new Error('每次请选择1–200份草稿。');
    if(items.some(i=>!i.to.length))throw new Error('请填写收件邮箱。');
    if(action==='extractDrafts'&&preview?.accountId!==accountId)throw new Error('来源账户已变化，请重新预览。');
    const result=await commitWorkbenchDrafts({accountId,sourceId:preview?.sourceId,sourceUpdatedAt:preview?.sourceUpdatedAt,requestId,items});
    if(!current())return;setReceipts(result);props.onCompleted?.(result);setConfirmed(false);
    setNotice(`新保存 ${result.filter(r=>r.created).length} 份，之前已处理 ${result.filter(r=>!r.created).length} 份。没有发送任何邮件。`);
    await refresh();
  });}
  function openDraft(id:string){void run(async current=>{
    const message=await getMessage(id);if(!message||message.account_id!==accountId||!message.is_draft)throw new Error('这份草稿已不存在或已经加入发送队列。');
    const snapshot=await loadMessageForEditing(id);if(current())useComposeStore.getState().openDraft(snapshot);
  });}
  function openDrafts(){void run(async current=>{
    const folders=await listFolders(accountId);const folder=folders.find(f=>f.role==='drafts');
    if(!folder)throw new Error('尚无草稿箱，请先保存草稿。');
    if(current()){useMailStore.getState().setActiveAccountId(accountId);useMailStore.getState().setActiveFolderId(folder.id);useMailStore.getState().setSearchScope(null);useUIStore.getState().setActiveView('inbox');}
  });}
  function loadDraft(){void run(async current=>{
    if(!target)throw new Error('请选择一份本地草稿。');
    const message=await getMessage(target);
    if(!message||message.account_id!==accountId||!message.is_draft||message.is_deleted)throw new Error('只能选择当前账户尚未入队的草稿。');
    if(message.remote_id&&!message.remote_id.startsWith('__local_draft__:'))throw new Error('远端草稿请先在完整写信窗口核对，本入口不改写服务器草稿。');
    const files=await listAttachments(target);if(!current())return;
    setDraft(message);setAttachments(files);setGuard(null);setRiskAccepted(false);setScheduleConfirmed(false);
  });}
  function checkSchedule(){void run(async current=>{
    if(!draft)throw new Error('请先读取并核对草稿。');
    const verdict=await checkSendGuard({accountId,to:draft.to_list.map(a=>a.address),cc:draft.cc_list.map(a=>a.address),bcc:draft.bcc_list.map(a=>a.address),subject:draft.subject,bodyText:draft.body_text});
    if(current()){setGuard(verdict);setRiskAccepted(false);setScheduleConfirmed(false);}
  });}
  function schedule(){void run(async current=>{
    const at=Math.floor(new Date(time).getTime()/1000);
    if(!draft||!Number.isFinite(at)||at<=Date.now()/1000+5)throw new Error('请选择至少晚于当前5秒的发送时间。');
    if(!guard||guard.level==='block'||(guard.level!=='ok'&&!riskAccepted)||!scheduleConfirmed)throw new Error('请完成风险检查并明确确认；高风险草稿请在完整写信窗口核对。');
    const id=await scheduleWorkbenchDraft(accountId,draft.id,draft.updated_at,at);if(!current())return;
    const row={draftId:draft.id,operationId:id,sendAt:at};setSchedules(old=>[...old,row]);props.onScheduled?.(row);
    setDraft(null);setGuard(null);setScheduleConfirmed(false);setNotice('已保存定时任务，到期后由发送队列处理。请保持软件运行并联网；实际结果请核对发送队列与已发送，失败会暂停并提醒。');await refresh();
  });}
  function cancel(row:WorkbenchSchedule){void run(async current=>{
    await cancelWorkbenchSchedule(accountId,row.operationId);if(!current())return;
    setSchedules(old=>old.filter(x=>x.operationId!==row.operationId));props.onCancelled?.(row.operationId);
    setNotice('定时任务已取消，邮件已恢复为草稿。');await refresh();
  });}
  function organize(){void run(async current=>{
    if(!confirmed||!selected.size)throw new Error('请先选择邮件并确认操作。');
    const folders=operation==='trash'?await listFolders(accountId):[];const trash=folders.find(f=>f.role==='trash');
    if(operation==='trash'&&!trash)throw new Error('当前账户没有废纸篓，已停止；不会永久删除邮件。');
    const results:string[]=[];let ok=0;
    for(const source of sourceMessages.filter(s=>selected.has(s.id))){
      if(!current())break;
      try{
        const message=await getMessage(source.id);if(!message||message.account_id!==accountId||message.is_deleted)throw new Error('不属于当前账户或已删除');
        if(!current())break;
        if(operation==='archive')await archiveMessage(source.id);
        else if(operation==='trash')await moveToFolder(source.id,trash!.id);
        else await updateMessageFlags(source.id,operation==='read'?true:operation==='unread'?false:undefined,operation==='star'?true:operation==='unstar'?false:undefined);
        ok++;
      }catch(e){results.push(`${source.title}：${extractErrorMessage(e)}`);}
    }
    if(current()){setNotice(`已提交 ${ok} 封的操作，失败 ${results.length} 封。服务器同步可能仍在排队。`);setError(results.join('\n'));setConfirmed(false);await refresh();}
  });}
  const candidates=[...sourceMessages,...receipts.filter(r=>r.exists).map(r=>({id:r.draftId,title:`已保存草稿 ${preview?.items.find(i=>i.key===r.key)?.subject||subject||r.key}`}))].filter((x,i,all)=>all.findIndex(y=>y.id===x.id)===i);
  const showSchedule=action==='schedule'||receipts.some(r=>r.exists);
  return <section aria-label={labels[action]} style={{border:'1px solid var(--color-border)',borderRadius:7,padding:12,marginTop:12,fontSize:12,background:'var(--color-bg-secondary)'}}>
    <strong style={{fontSize:14}}>{labels[action]}</strong>
    <p>以下是待确认的实际操作。准备或预览不会创建草稿，也不会发送邮件。</p>
    <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0,display:'grid',gap:9}}>
      {action==='extractDrafts'&&<>
        <label>来源邮件<select aria-label="来源邮件" value={source} onChange={e=>{setSource(e.target.value);setPreview(null);setSelected(new Set());setConfirmed(false);}} style={field}>
          <option value="">请选择一封来源邮件</option>{sourceMessages.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}
        </select></label>
        <button type="button" style={button} onClick={prepare}>读取完整写信链接并预览</button>
        {preview&&<>
          <strong>找到 {preview.items.length} 份完整邮件，已选 {selected.size} 份（每批最多200份）</strong>
          {preview.warnings.map(w=><div key={w} role="note">{w}</div>)}
          <div><button type="button" style={button} onClick={()=>{setSelected(new Set(preview.items.map(i=>i.key)));setConfirmed(false);}}>全选</button> <button type="button" style={button} onClick={()=>{setSelected(new Set());setConfirmed(false);}}>取消全选</button></div>
          <div style={{maxHeight:330,overflow:'auto'}}>{preview.items.map(item=><div key={item.key} style={{borderBottom:'1px solid var(--color-border)',padding:'8px 0'}}>
            <label><input type="checkbox" checked={selected.has(item.key)} onChange={()=>toggle(item.key)}/> <strong>{item.subject||'（无主题）'}</strong></label>
            <div>收件人：{item.to.join(', ')}</div>{item.cc.length>0&&<div>抄送：{item.cc.join(', ')}</div>}{item.bcc.length>0&&<div>密送：{item.bcc.join(', ')}</div>}
            <details><summary>查看原始正文</summary><div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.bodyText}</div></details>
          </div>)}</div>
        </>}
      </>}
      {action==='saveDraft'&&<>
        <label>收件邮箱<input aria-label="草稿收件邮箱" value={to} onChange={e=>{setTo(e.target.value);setConfirmed(false);}} style={field} placeholder="多个邮箱用逗号分隔"/></label>
        <label>抄送<input aria-label="草稿抄送" value={cc} onChange={e=>{setCc(e.target.value);setConfirmed(false);}} style={field}/></label>
        <label>密送<input aria-label="草稿密送" value={bcc} onChange={e=>{setBcc(e.target.value);setConfirmed(false);}} style={field}/></label>
        <label>主题<input aria-label="草稿主题" value={subject} onChange={e=>{setSubject(e.target.value);setConfirmed(false);}} style={field}/></label>
        <label>正文<textarea aria-label="草稿正文" rows={7} value={body} onChange={e=>{setBody(e.target.value);setConfirmed(false);}} style={field}/></label>
      </>}
      {(action==='saveDraft'||(action==='extractDrafts'&&preview))&&<>
        <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 我已核对收件人和正文，仅保存为本地草稿，不发送</label>
        <button type="button" disabled={!confirmed} onClick={save} style={button}>确认保存{action==='extractDrafts'?`选中的 ${selected.size} 份`:''}草稿</button>
      </>}
      {receipts.length>0&&<div><strong>保存回执</strong>{receipts.map(r=><div key={r.key}>{r.created?'已新建':r.exists?'此前已保存':'此前已处理，草稿已移除或入队'} {r.exists&&<button type="button" style={button} onClick={()=>openDraft(r.draftId)}>打开草稿</button>}</div>)}<button type="button" style={button} onClick={openDrafts}>打开草稿箱</button></div>}
      {action==='organize'&&<>
        {sourceMessages.map(s=><label key={s.id}><input type="checkbox" checked={selected.has(s.id)} onChange={()=>toggle(s.id)}/>{s.title}</label>)}
        {!sourceMessages.length&&<p>请先附加要整理的邮件，不会自动对整个邮箱执行操作。</p>}
        <select aria-label="邮件整理操作" style={field} value={operation} onChange={e=>{setOperation(e.target.value);setConfirmed(false);}}><option value="read">标记已读</option><option value="unread">标记未读</option><option value="star">添加星标</option><option value="unstar">取消星标</option><option value="archive">归档</option><option value="trash">移入废纸篓（不永久删除）</option></select>
        <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 确认对选中的 {selected.size} 封邮件执行上方操作</label>
        <button type="button" disabled={!confirmed||!selected.size} style={button} onClick={organize}>确认执行邮件整理</button>
      </>}
      {showSchedule&&<details open={action==='schedule'}><summary><strong>定时发送草稿</strong></summary><div style={{display:'grid',gap:8,paddingTop:9}}>
        <p>软件关闭时计划会保留；只有软件运行且联网时才会发送。到期后可能立即发送，请先核对时间。</p>
        <select aria-label="定时草稿" value={target} style={field} onChange={e=>{setTarget(e.target.value);setDraft(null);setGuard(null);setScheduleConfirmed(false);}}><option value="">选择本地草稿</option>{candidates.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select>
        <button type="button" onClick={loadDraft} style={button}>读取草稿预览</button>
        {draft&&<>
          <strong>{draft.subject||'（无主题）'}</strong><div>收件：{draft.to_list.map(a=>a.address).join(', ')}</div><div>抄送：{draft.cc_list.map(a=>a.address).join(', ')||'无'}；密送：{draft.bcc_list.map(a=>a.address).join(', ')||'无'}</div>
          <div style={{whiteSpace:'pre-wrap',maxHeight:220,overflow:'auto'}}>{draft.body_text||'正文为HTML，请打开草稿核对完整格式。'}</div><div>附件：{attachments.map(a=>a.filename).join('、')||'无'}（含内嵌图片的原记录会保留）</div>
          <label>本地时间<input aria-label="计划发送时间" type="datetime-local" style={field} value={time} onChange={e=>{setTime(e.target.value);setScheduleConfirmed(false);}}/></label>
          <button type="button" style={button} onClick={checkSchedule}>检查发送风险</button>
          {guard&&<div role="note">{guard.level==='ok'?'风险检查通过':guard.reasons.join('；')||'请核对发送风险'}{guard.level==='block'&&<p>请打开完整写信窗口处理此风险。</p>}</div>}
          {guard&&guard.level==='warn'&&<label><input type="checkbox" checked={riskAccepted} onChange={e=>setRiskAccepted(e.target.checked)}/> 已核对上述风险，仍按此内容定时发送</label>}
          <label><input type="checkbox" checked={scheduleConfirmed} onChange={e=>setScheduleConfirmed(e.target.checked)}/> 已核对本草稿、账号、收件人和发送时间，确认加入自动发送队列</label>
          <button type="button" disabled={!scheduleConfirmed||!guard||guard.level==='block'||(guard.level!=='ok'&&!riskAccepted)} style={button} onClick={schedule}>确认定时发送这份草稿</button>
        </>}
        {schedules.map(row=><div key={row.operationId}>已登记计划：{new Date(row.sendAt*1000).toLocaleString()} {row.sendAt>Date.now()/1000?<button type="button" style={button} onClick={()=>cancel(row)}>取消此定时任务并恢复草稿</button>:<span>已到计划时间，请核对实际发送结果。</span>}</div>)}
        <button type="button" style={button} onClick={()=>{useUIStore.getState().setSettingsTab('remoteWrites');useUIStore.getState().setActiveView('settings');}}>查看发送队列与定时任务</button>
      </div></details>}
    </fieldset>
    {busy&&<p role="status">正在处理，请稍候…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert" style={{color:'var(--color-error)',whiteSpace:'pre-wrap'}}>{error}</p>}
  </section>;
}
