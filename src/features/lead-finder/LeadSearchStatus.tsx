import { LEAD_PHASE_TEXT, type LeadTaskPhase } from './leadTaskProgress';
import './LeadFinderPresentation.css';

export default function LeadSearchStatus({ phase, contactsRunning = 0, background = false, onShowTask }: {
  phase?: LeadTaskPhase; contactsRunning?: number; background?: boolean; onShowTask?: () => void;
}) {
  if (!phase && !contactsRunning) return null;
  return <div className="lead-search-status">
    <span className="lead-search-status__spinner" aria-hidden="true" />
    <span role="status" aria-live="polite" aria-atomic="true">{background ? '后台任务：' : ''}{phase ? LEAD_PHASE_TEXT[phase] : '正在补充公开邮箱及联系信息…'}</span>
    {background && onShowTask && <button type="button" onClick={onShowTask}>查看任务</button>}
  </div>;
}
