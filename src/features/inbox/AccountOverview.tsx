import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AlertCircle, Clock3, ListTodo, Pin, RefreshCw, ShieldAlert } from 'lucide-react';
import { generateAccountOverview, setAccountOverviewFeedback, setAccountOverviewSettings,
  type AccountOverviewSettings,
  type AccountOverviewData, type AccountOverviewItem, type AccountOverviewProof, type OverviewBucket } from '@/lib/api';
import { useMailStore } from '@/stores/mail.store';
import { useUIStore } from '@/stores/ui.store';
import { extractErrorMessage } from '@/lib/extractErrorMessage';
import EvidenceReportView from '@/features/home/EvidenceReportView';
import { peekAccountOverview, pendingAccountOverviewGeneration, readAccountOverview, updateAccountOverview, runAccountOverviewGeneration } from './accountOverviewCache';
import './AccountOverview.css';
import OverviewNotice from './OverviewNotice';

const BUCKETS: Array<{ id: OverviewBucket; label: string; icon: typeof ListTodo }> = [
  { id: 'needs_action', label: '需我处理', icon: ListTodo },
  { id: 'waiting', label: '等待对方', icon: Clock3 },
  { id: 'risk', label: '期限与风险', icon: ShieldAlert },
];
const dateText = (stamp: number) => new Date(stamp * 1000).toLocaleString();
function refreshIssue(error: string) {
  if (/超时/.test(error)) return 'AI 响应超时';
  if (/HTTP (401|403)\b/.test(error)) return 'AI 服务拒绝访问，请检查模型配置';
  if (/HTTP 429\b/.test(error)) return 'AI 服务限流，请稍后重试';
  if (/网络请求失败/.test(error)) return '连接 AI 服务失败';
  if (/事项结构|事项字段|完整答案|响应格式/.test(error)) return 'AI 未返回可用的事项格式';
  if (/暂无可用正文/.test(error)) return '候选邮件还没有可用正文';
  if (/原信核验/.test(error)) return 'AI 提出的事项未通过原信核验';
  return '最近一次更新未完成';
}

export default function AccountOverview({ accountId }: { accountId: string }) {
  const [data, setData] = useState<AccountOverviewData | null>(() => peekAccountOverview(accountId));
  const [days, setDays] = useState(() => peekAccountOverview(accountId)?.settings?.windowDays ?? 7);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const operation = useRef(0);
  const changeSequence = useRef(0);
  const account = useRef(accountId);
  account.current = accountId;
  const setView = useUIStore(s => s.setActiveView);
  const setDetail = useUIStore(s => s.setMessageDetailId);
  const openMessage = useUIStore(s => s.openMessageInInbox);

  function checked(result: AccountOverviewData) {
    if (result.accountId !== accountId || (result.snapshot && result.snapshot.accountId !== accountId)) {
      throw new Error('事项结果账户不匹配，未显示其他账户内容');
    }
    return result;
  }
  useEffect(() => {
    const token = ++epoch.current;
    const sequence = changeSequence.current;
    const cached = peekAccountOverview(accountId);
    setData(cached); setError(''); setLoading(true); setGenerating(false); setSaving(false); setDays(cached?.settings?.windowDays ?? 7);
    // Rejoin work started before leaving, rather than starting another model
    // call or waiting for the next 30-second disk-cache poll to see its result.
    const pending = pendingAccountOverviewGeneration(accountId);
    if (pending) {
      setGenerating(true);
      void pending.then(result => {
        if (epoch.current !== token || account.current !== accountId) return;
        setData({...checked(result),stale:result.stale || changeSequence.current !== sequence});
        setDays(result.settings?.windowDays ?? 7);
      }).catch(cause => {
        if (epoch.current !== token || account.current !== accountId) return;
        setError(`${extractErrorMessage(cause)}。上次结果仍保留。`);
      }).finally(() => {
        if (epoch.current === token && account.current === accountId) setGenerating(false);
      });
    }
    readAccountOverview(accountId).then(result => {
      if (epoch.current !== token || account.current !== accountId) return;
      setData({ ...checked(result), stale: result.stale || changeSequence.current !== sequence }); setDays(result.settings?.windowDays ?? 7);
    }).catch(cause => {
      if (epoch.current === token && account.current === accountId) setError(extractErrorMessage(cause));
    }).finally(() => {
      if (epoch.current === token && account.current === accountId) setLoading(false);
    });
    return () => { ++epoch.current; };
  }, [accountId]);
  useEffect(() => {
    let alive = true;
    const subscriptions = ['mail:new', 'mail:messages-changed'].map(name => listen<{ account_id?: string }>(name, event => {
      if (!alive || account.current !== accountId || event.payload?.account_id !== accountId) return;
      ++changeSequence.current;
      setData(previous => previous?.accountId === accountId ? { ...previous, stale: !!previous.snapshot } : previous);
    }).catch(() => () => {}));
    return () => { alive = false; subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()).catch(() => {}); }); };
  }, [accountId]);

  // A new prop can render before the effect resets state: gate by account now.
  const current = data?.accountId === accountId ? data : peekAccountOverview(accountId);
  const displayDays = data?.accountId === accountId ? days : current?.settings?.windowDays ?? 7;
  const snapshot = current?.snapshot;
  const feedback = current?.feedback ?? [];
  const feedbackFor = (id: string) => feedback.find(entry => entry.id === id);
  const ignored = (item: AccountOverviewItem) => {
    const entry = feedbackFor(item.id);
    return entry?.ignoredThrough != null && (entry.ignoredRevision ? entry.ignoredRevision === item.revision : item.latestDate <= entry.ignoredThrough);
  };
  const busy = loading || generating || saving;
  const stale = !!snapshot && (current?.stale || snapshot.scope.windowDays !== displayDays);
  const revisionKey = `${snapshot?.revision ?? 'none'}:${snapshot?.generatedAt ?? 0}`;
  const errorKey = `error:${revisionKey}:${current?.lastAttempt ?? 0}:${error || current?.autoError || ''}`;
  const staleKey = `stale:${revisionKey}:${displayDays}`;

  // A generation may finish after this page was left. Read the encrypted local
  // cache quietly so re-entering (or changing settings in another window) does
  // not leave an old result on screen until the next paid-refresh interval.
  useEffect(() => {
    if (busy || !current) return;
    const token = epoch.current;
    let pending = false;
    let alive = true;
    let queued = false;
    const refresh = () => {
      if (!alive || document.hidden) return;
      if (pending) { queued = true; return; }
      pending = true;
      const requestVersion = operation.current;
      const sequence = changeSequence.current;
      void readAccountOverview(accountId).then(result => {
        if (!alive || epoch.current !== token || account.current !== accountId || operation.current !== requestVersion) return;
        setData({...checked(result),stale:result.stale || changeSequence.current !== sequence});
        setDays(result.settings?.windowDays ?? 7);
      }).catch(() => {}).finally(() => {
        pending = false;
        if (queued) { queued = false; refresh(); }
      });
    };
    const subscription = listen<string>('account-overview:updated', event => {
      if (event.payload === accountId) refresh();
    }).catch(() => () => {});
    const timer = window.setInterval(refresh,30_000);
    return () => { alive = false; window.clearInterval(timer); void subscription.then(unlisten => unlisten()).catch(() => {}); };
  }, [accountId,busy,!!current]);

  async function preferences(settings: AccountOverviewSettings) {
    if (loading || saving) return;
    const token = epoch.current;
    ++operation.current;
    const sequence = changeSequence.current;
    setSaving(true); setError('');
    try {
      const result = await updateAccountOverview(accountId,() => setAccountOverviewSettings(accountId,settings));
      if (epoch.current === token && account.current === accountId) {
        setData({ ...checked(result), stale: result.stale || changeSequence.current !== sequence });
        setDays(result.settings?.windowDays ?? settings.windowDays);
      }
    } catch (cause) {
      if (epoch.current === token && account.current === accountId) setError(extractErrorMessage(cause));
    } finally {
      if (epoch.current === token && account.current === accountId) setSaving(false);
    }
  }

  async function generate() {
    if (busy) return;
    const token = epoch.current;
    ++operation.current;
    const sequence = changeSequence.current;
    setError(''); setGenerating(true);
    try {
      const result = await runAccountOverviewGeneration(accountId,displayDays,() => generateAccountOverview(accountId,displayDays));
      if (epoch.current === token && account.current === accountId) {
        setData({ ...checked(result), stale: result.stale || changeSequence.current !== sequence });
      }
    } catch (cause) {
      if (epoch.current === token && account.current === accountId) {
        setError(`${extractErrorMessage(cause)}。上次结果仍保留。`);
        // A native analysis failure is persisted before IPC rejects. Reconcile
        // its attempt identity now, so the next local poll does not resurrect
        // the same dismissed error under a different notice key.
        try {
          const persisted = await readAccountOverview(accountId);
          if (epoch.current === token && account.current === accountId && persisted.autoError) {
            setData({...checked(persisted),stale:persisted.stale || changeSequence.current !== sequence});
            setError('');
          }
        } catch { /* Keep the IPC error if the cache is unavailable. */ }
      }
    } finally {
      if (epoch.current === token && account.current === accountId) setGenerating(false);
    }
  }
  async function change(id: string, action: 'pin' | 'unpin' | 'ignore' | 'restore') {
    if (busy) return;
    const token = epoch.current;
    ++operation.current;
    const sequence = changeSequence.current;
    setSaving(true); setError('');
    try {
      const result = await updateAccountOverview(accountId,() => setAccountOverviewFeedback(accountId,id,action));
      if (epoch.current === token && account.current === accountId) setData({ ...checked(result), stale: result.stale || changeSequence.current !== sequence });
    } catch (cause) {
      if (epoch.current === token && account.current === accountId) setError(extractErrorMessage(cause));
    } finally {
      if (epoch.current === token && account.current === accountId) setSaving(false);
    }
  }
  function openProof(proof: AccountOverviewProof) {
    const mail = useMailStore.getState();
    // Opening is allowed only for a source contained in this account snapshot.
    if (!snapshot?.items.some(item => item.proofs.some(p => p.messageId === proof.messageId))) return;
    mail.setActiveAccountId(accountId);
    if (proof.folderId) mail.setActiveFolderId(proof.folderId);
    mail.setSearchScope(null);
    openMessage(proof.messageId); setDetail(proof.messageId); setView('messageDetail');
  }

  return <section className="account-overview" aria-label="账户事项总览">
    <div className="account-overview__heading">
      <div><h2>账户事项总览</h2><p>优先显示上次结果。开启自动生成后，软件运行时会在后台更新；候选邮件正文会交给您配置的 AI，可能产生费用。关闭后停止安排新任务。</p></div>
      <div className="account-overview__controls">
        <label className="account-overview__auto"><input type="checkbox" role="switch" aria-label="自动生成账户事项总览" checked={current?.settings?.autoGenerate ?? false} disabled={loading || saving}
          onChange={event => void preferences({autoGenerate:event.target.checked,windowDays:displayDays})} />自动生成</label>
        <label>时间范围 <select aria-label="事项候选时间窗口" value={displayDays} disabled={loading || saving} onChange={event => {
          const windowDays = Number(event.target.value);
          if (current?.settings) void preferences({autoGenerate:current.settings.autoGenerate,windowDays});
          else setDays(windowDays);
        }}>
          <option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option>
        </select></label>
        <button type="button" onClick={() => void generate()} disabled={busy}><RefreshCw size={14} className={generating ? "app-spin" : undefined} />{generating ? snapshot ? '后台更新中…' : '正在取证…' : snapshot ? '刷新事项' : '生成事项总览'}</button>
      </div>
    </div>
    {loading && !snapshot && <p role="status">正在读取本地事项缓存，不调用模型…</p>}
    {!generating && (error || current?.autoError) && <OverviewNotice key={`${accountId}:${errorKey}`} accountId={accountId} noticeId={errorKey} label="分析失败提示" expiresAfter={15_000} alert>
      <AlertCircle size={15} /> {error || `${refreshIssue(current?.autoError ?? '')}。${snapshot ? '已保留上次结果，' : ''}可手动重试。`}
    </OverviewNotice>}
    {stale && <OverviewNotice key={`${accountId}:${staleKey}`} accountId={accountId} noticeId={staleKey} label="缓存变更提示" expiresAfter={12_000}>
      本地邮件数据已有变化或时间范围已调整；以下仍是上次结果，更新后再据此处理。
    </OverviewNotice>}
    {generating && <p role="status">{snapshot ? '上次结果已显示，AI 正在后台更新；不会清空卡片…' : '正在核实邮件往来并整理事项…'}</p>}
    {snapshot && <div className="account-overview__coverage">
      {stale ? '缓存结果（待更新）' : '缓存结果'} · 上次生成：{dateText(snapshot.generatedAt)} · 候选近 {snapshot.scope.windowDays} 天，扫描邮件头 {snapshot.scope.scanned} 封，排除明显营销订阅 {snapshot.scope.filteredBulk} 封，忽略旧事项邮件 {snapshot.scope.ignored} 封，提供候选 {snapshot.scope.selected} 封
      {current?.autoError && <span>最近一次更新未成功；以上是上次成功结果，不是本次新结论。</span>}
      {snapshot.scope.pinnedOutsideWindow > 0 && `；另含 ${snapshot.scope.pinnedOutsideWindow} 封窗口外重点邮件`}
      <span> 仅本地已同步邮件；非全邮箱结论，不会因为未读就判为重要，也不会因为有回复就判为完成。</span>
    </div>}
    {!loading && !snapshot && <div className="account-overview__empty">{current?.settings?.autoGenerate ? '将自动整理当前时间范围的商务事项；可先关闭“自动生成”，改为手动刷新。' : '点击“生成事项总览”，AI 会结合往来正文整理需您处理、等待对方及期限风险。'}</div>}
    {snapshot && <>
      <div className="account-overview__grid">{BUCKETS.map(bucket => {
        const cards = snapshot.items.filter(item => item.bucket === bucket.id && !ignored(item))
          .sort((a,b) => Number(!!feedbackFor(b.id)?.pinned) - Number(!!feedbackFor(a.id)?.pinned) || b.latestDate - a.latestDate);
        const Icon = bucket.icon;
        return <section className={`account-overview__column account-overview__column--${bucket.id}`} key={bucket.id} aria-label={bucket.label}>
          <h3><Icon size={21} />{bucket.label}<span>{cards.length}</span></h3>
          {cards.length === 0 && <p className="account-overview__empty">本轮未形成可核验事项，不代表没有待办。</p>}
          {cards.map(item => <article className="account-overview__card" key={item.id}>
            <h4>{feedbackFor(item.id)?.pinned && <Pin size={12} aria-label="已标重点" />}{item.title}</h4>
            <span className="account-overview__badge">{item.needsVerification ? '证据不完整／需核验' : 'AI 建议，处理前请核对原信'}</span>
            <p>{item.summary}</p>
            {item.dueText && <p>原文期限：{item.dueText}</p>}
            <p><strong>下一步：</strong>{item.nextAction}</p>
            <details><summary>原信依据（{item.proofs.length}）</summary>{item.proofs.map(proof => <div className="account-overview__proof" key={proof.messageId}>
              <button type="button" onClick={() => openProof(proof)}>{proof.label || '无主题'}</button>
              <small>{proof.sender} · {dateText(proof.date)}</small><blockquote>{proof.quote}</blockquote>
            </div>)}</details>
            <div className="account-overview__actions">
              <button type="button" disabled={busy} onClick={() => void change(item.id, feedbackFor(item.id)?.pinned ? 'unpin' : 'pin')}>{feedbackFor(item.id)?.pinned ? '取消重点' : '标为重点'}</button>
              <button type="button" disabled={busy} onClick={() => void change(item.id,'ignore')}>忽略此事项</button>
            </div>
          </article>)}
        </section>;
      })}</div>
      {snapshot.warnings.map((warning,index) => <p className="account-overview__coverage" key={index}>{warning}</p>)}
      <EvidenceReportView report={snapshot.evidenceReport} />
    </>}
    {feedback.length > 0 && <details className="account-overview__feedback"><summary>重点／忽略记录（{feedback.length}）</summary>
      <p>反馈仅影响事项总览，不删除或移动邮件。忽略只针对当时已知的往来；有更新邮件时，刷新后可重新出现。</p>
      {feedback.map(entry => <div key={entry.id}><span>{entry.label} · {entry.pinned ? '重点' : '已忽略的旧往来'}</span>
        <button type="button" disabled={busy} onClick={() => void change(entry.id,entry.pinned ? 'unpin' : 'restore')}>{entry.pinned ? '取消重点记录' : '恢复此事项'}</button></div>)}
    </details>}
    <p className="account-overview__footnote">事项和反馈加密保存在当前 data 数据库，不依赖 Dev 网页存储。只做分析与建议，不会自动发送、删除、移动或标记邮件。</p>
    <p className="account-overview__footnote">开启后，软件运行时会在后台检查。证据相同的近期结果可直接复用，自动分析至少间隔 15 分钟。手动刷新可立即重新分析。</p>
    {current?.settings?.autoGenerate && current.nextAutoAt != null && <p className="account-overview__coverage">{current.nextAutoAt * 1000 > Date.now() ? `最早下次自动更新检查：${dateText(current.nextAutoAt)}` : '已到更新检查时间，软件将在后台核对。'} · 打开此页只读取本地缓存，不调用 AI。</p>}
  </section>;
}
