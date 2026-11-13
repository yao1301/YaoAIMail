import { beforeEach, describe, expect, it, vi } from 'vitest';
import { explicitlyRequestsDraft, requestedWorkbenchAction, planWorkbenchTask, type TaskContext, type WorkbenchTask } from './workbenchTask';
const h = vi.hoisted(() => ({ aiPrompt: vi.fn() }));
vi.mock('@/lib/api', () => h);
const context: TaskContext = { history: [], hasEvidence: false, evidenceNames: [] };
const plan = (overrides: Partial<WorkbenchTask> = {}): WorkbenchTask => ({ kind: 'chat', useMail: false, useKnowledge: false, useWeb: false, generateDraft: false, skillId: null, ...overrides });
beforeEach(() => { vi.resetAllMocks(); h.aiPrompt.mockRejectedValue(new Error('Example offline classifier')); });
describe('mail secretary task planning', () => {
  it('recognizes splitting button links into drafts without mistaking it for analysis',async()=>{
    const prompt='你帮我把这封邮件里的“写信”按钮拆开，成一封封邮件放到草稿箱里面';
    expect(explicitlyRequestsDraft(prompt)).toBe(true);expect((await planWorkbenchTask(prompt,context)).action).toBe('extractDrafts');
  });
  it('proposes execution previews but never treats explanation or negation as execution',()=>{
    expect(requestedWorkbenchAction('请定时发送这份草稿')).toBe('schedule');
    expect(requestedWorkbenchAction('帮我把邮件标记为已读')).toBe('organize');
    expect(requestedWorkbenchAction('把上面那封保存到草稿箱')).toBe('saveDraft');
    expect(requestedWorkbenchAction('解释如何定时发送邮件')).toBeUndefined();
    expect(requestedWorkbenchAction('不要拆开邮件生成草稿')).toBeUndefined();
    expect(explicitlyRequestsDraft('不要保存草稿')).toBe(false);
  });
  it.each(['不要写邮件，只综合几封邮件给结论', '不要写开发信，只解释开发信是什么意思', '什么是 follow-up？', '如何写邮件？', '他在邮件里说“帮我写邮件”，这是什么意思？', "Don't write an email; summarize this thread", '客户投诉这种情况怎么回复？'])('does not authorize a draft: %s', async prompt => {
    const result = await planWorkbenchTask(prompt, context);
    expect(result.generateDraft).toBe(false);
    expect(result.kind).not.toBe('writing');
    expect(result.skillId).not.toBe('research-first-outreach');
  });
  it.each(['帮我写一封英文邮件', '给客户回复一封确认交期的邮件', '不要总结，帮我写一封邮件', '帮我回复他确认交期', 'Draft an email to the buyer', 'Please reply to this email'])('recognizes an explicit drafting request: %s', prompt => {
    expect(explicitlyRequestsDraft(prompt)).toBe(true);
  });
  it('does not let a model misclassification authorize writing', async () => {
    h.aiPrompt.mockResolvedValue(JSON.stringify(plan({ kind: 'writing', generateDraft: true, skillId: 'research-first-outreach' })));
    const result = await planWorkbenchTask('请解释国际贸易术语', context);
    expect(result).toEqual(plan());
  });
  it('supports compound research plus drafting without page navigation', async () => {
    h.aiPrompt.mockResolvedValue(JSON.stringify(plan({ kind: 'writing', useMail: true, useKnowledge: true, useWeb: true, generateDraft: true, skillId: 'research-first-outreach' })));
    const result = await planWorkbenchTask('研究客户官网，结合往来和产品资料，帮我写一封英文开发信', { ...context, hasEvidence: true });
    expect(result).toMatchObject({ useMail: true, useKnowledge: true, useWeb: true, generateDraft: true });
  });
  it('uses bounded conversation and evidence identities to resolve followups', async () => {
    const previousTask = plan({ kind: 'mail', useMail: true });
    const history = Array.from({ length: 10 }, (_, index) => ({ role: 'user' as const, content: `Example ${index}` }));
    const result = await planWorkbenchTask('再比较第二封', { ...context, history, previousTask, hasEvidence: true, evidenceNames: ['Example selected mail'] });
    expect(result.useMail).toBe(true);
    const sent = JSON.parse(h.aiPrompt.mock.calls[0][1]);
    expect(sent.history).toHaveLength(6); expect(sent.evidenceNames).toEqual(['Example selected mail']);
  });
  it('allows drafting refinements only after an explicitly drafted result', () => {
    expect(explicitlyRequestsDraft('再短一点', plan({ kind: 'writing', generateDraft: true }))).toBe(true);
    expect(explicitlyRequestsDraft('再短一点', plan({ kind: 'mail', generateDraft: false }))).toBe(false);
    expect(explicitlyRequestsDraft('先不要写邮件，只总结', plan({ generateDraft: true }))).toBe(false);
    expect(explicitlyRequestsDraft('再比较第二封', plan({ generateDraft: true }))).toBe(false);
    expect(explicitlyRequestsDraft('再查客户最新资料', plan({ generateDraft: true }))).toBe(false);
  });
  it('rejects malformed planner booleans and retains safe fallback', async () => {
    h.aiPrompt.mockResolvedValue('{"kind":"writing","generateDraft":"true"}');
    expect((await planWorkbenchTask('综合这几封邮件给结论', context)).generateDraft).toBe(false);
  });
  it('honors no-network instruction and does not turn manual strategies into drafting', async () => {
    h.aiPrompt.mockResolvedValue(JSON.stringify(plan({ useWeb: true, generateDraft: true })));
    const result = await planWorkbenchTask('不要联网，分析客户邮件给回复策略', { ...context, manualSkillId: 'account-research' });
    expect(result.useWeb).toBe(false); expect(result.generateDraft).toBe(false);
  });
  it('distinguishes explaining a concept from explaining a received mail', async () => {
    expect((await planWorkbenchTask('请解释我收到的邮件', context)).useMail).toBe(true);
    expect((await planWorkbenchTask('解释邮件服务器的原理', context)).useMail).toBe(false);
  });
});
