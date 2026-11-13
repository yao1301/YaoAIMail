import { create } from 'zustand';

export type LeadTaskPhase = 'context' | 'understanding' | 'searching' | 'reviewing' | 'finishing';
export const LEAD_PHASE_TEXT: Record<LeadTaskPhase, string> = {
  context: '正在读取参考资料…', understanding: '正在理解你的指令…',
  searching: '正在搜索客户并读取官网…', reviewing: '正在核验公司资料并整理结果…', finishing: '正在整理本次结果…',
};

/** Uses work already being done; never starts a timer, model call or extra poll. */
export function phaseForLeadReport(report?: { sitesRead?: number; reviewedCompanies?: number }): LeadTaskPhase {
  return (report?.sitesRead || report?.reviewedCompanies || 0) > 0 ? 'reviewing' : 'searching';
}

export const useLeadTaskProgress = create<{
  active: { sessionId: string; phase: LeadTaskPhase } | null;
  update: (sessionId: string, phase: LeadTaskPhase) => void;
  finish: (sessionId: string) => void;
}>((set) => ({
  active: null,
  update: (sessionId, phase) => set(state => state.active?.sessionId === sessionId && state.active.phase === phase
    ? state : { active: { sessionId, phase } }),
  finish: sessionId => set(state => state.active?.sessionId === sessionId ? { active: null } : state),
}));
