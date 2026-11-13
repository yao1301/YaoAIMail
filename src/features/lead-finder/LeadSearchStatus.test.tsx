import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LeadSearchStatus from './LeadSearchStatus';
import { phaseForLeadReport, useLeadTaskProgress } from './leadTaskProgress';
afterEach(()=>{cleanup();useLeadTaskProgress.setState({active:null});});
it('updates one short sentence from actual stages, without timers or network work',()=>{
  const timeout=vi.spyOn(window,'setTimeout');const interval=vi.spyOn(window,'setInterval');
  const view=render(<LeadSearchStatus phase="understanding"/>);
  expect(screen.getByRole('status').textContent).toBe('正在理解你的指令…');
  view.rerender(<LeadSearchStatus phase={phaseForLeadReport({sitesRead:0})}/>);expect(screen.getAllByRole('status')).toHaveLength(1);expect(screen.getByRole('status').textContent).toContain('正在搜索');
  view.rerender(<LeadSearchStatus phase={phaseForLeadReport({sitesRead:3,reviewedCompanies:1})}/>);expect(screen.getByRole('status').textContent).toContain('核验公司');
  view.rerender(<LeadSearchStatus contactsRunning={2}/>);expect(screen.getByRole('status').textContent).toContain('补充公开邮箱');
  view.rerender(<LeadSearchStatus/>);expect(screen.queryByRole('status')).toBeNull();
  expect(timeout).not.toHaveBeenCalled();expect(interval).not.toHaveBeenCalled();vi.restoreAllMocks();
});
it('retains stage across view changes and does not let another task clear it',()=>{
  useLeadTaskProgress.getState().update('a','understanding');useLeadTaskProgress.getState().update('b','reviewing');
  useLeadTaskProgress.getState().finish('a');expect(useLeadTaskProgress.getState().active).toEqual({sessionId:'b',phase:'reviewing'});
  useLeadTaskProgress.getState().finish('b');expect(useLeadTaskProgress.getState().active).toBeNull();
});
it('identifies a running background task while viewing history',()=>{
  const show=vi.fn();render(<LeadSearchStatus phase="searching" background onShowTask={show}/>);
  expect(screen.getByRole('status').textContent).toContain('后台任务');fireEvent.click(screen.getByRole('button',{name:'查看任务'}));expect(show).toHaveBeenCalledTimes(1);
});
