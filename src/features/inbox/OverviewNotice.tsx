import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { overviewNoticeState } from './accountOverviewCache';

/** Key by account + noticeId at the call site, so local state never crosses notices. */
export default function OverviewNotice({ accountId, noticeId, label, expiresAfter, children, alert = false }: {
  accountId: string; noticeId: string; label: string; expiresAfter?: number; children: ReactNode; alert?: boolean;
}) {
  const [notice] = useState(() => overviewNoticeState(accountId, noticeId));
  const [closed, setClosed] = useState(notice.dismissed || (expiresAfter != null && Date.now() >= notice.firstSeen + expiresAfter));
  useEffect(() => {
    if (closed || expiresAfter == null) return;
    const timer = window.setTimeout(() => { notice.dismissed = true; setClosed(true); }, Math.max(0, notice.firstSeen + expiresAfter - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notice, closed, expiresAfter]);
  if (closed) return null;
  return <div className="account-overview__notice" role={alert ? 'alert' : 'note'}>
    <span>{children}</span>
    <button type="button" aria-label={`关闭${label}`} title="关闭本条提示" onClick={() => { notice.dismissed = true; setClosed(true); }}><X size={14} /></button>
  </div>;
}
