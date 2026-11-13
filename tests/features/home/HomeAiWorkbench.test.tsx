import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomeAiWorkbench from '../../../src/features/home/HomeAiWorkbench';
import { HISTORY_KEY } from '../../../src/features/home/workbenchSession';

const h = vi.hoisted(() => ({
  extractDocumentText: vi.fn(),
  api: Object.fromEntries(['mailAssistantRun', 'agentRun', 'aiChat', 'aiPrompt', 'getMessagesBatch', 'listAccounts', 'listCustomerMemories', 'listFolders', 'listMessages', 'searchKnowledgeBase', 'listKnowledgeItems', 'searchMessages', 'readAttachmentFile'].map(key => [key, vi.fn()])),
  mail: { activeAccountId: 'account-a', setActiveAccountId: vi.fn(), setActiveFolderId: vi.fn(), setSearchScope: vi.fn() },
  ui: {
    openMessageInInbox: vi.fn(), setMessageDetailId: vi.fn(), setActiveView: vi.fn(), openRightPanel: vi.fn(), setSettingsTab: vi.fn(), setCustomerProfileEmail: vi.fn(),
    setAiWritingTurns: vi.fn(), setPendingAiWritingInstruction: vi.fn(),
    knowledgeContextQueue: [] as any[], clearKnowledgeContextQueue: vi.fn(), homeContextQueue: [] as any[], homeContextAttachmentQueue: [] as any[], clearHomeContextQueue: vi.fn(),
  },
}));
vi.mock('../../../src/lib/api', () => h.api);
vi.mock('../../../src/stores/mail.store', () => ({ useMailStore: Object.assign((selector: any) => selector(h.mail), { getState: () => h.mail }) }));
vi.mock('../../../src/stores/ui.store', () => ({ useUIStore: (selector: any) => selector(h.ui) }));
vi.mock('../../../src/lib/renderMarkdown', () => ({ default: ({ text }: any) => text === 'CITE_TEST' ? <div><a href="#mail:selected">Inline source</a><a href="#mail:unread">Forged source</a></div> : <div>{text}</div> }));
vi.mock('../../../src/components/KnowledgePicker', () => ({ default: () => null }));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:vi.fn().mockResolvedValue(undefined)})}));
vi.mock('../../../src/lib/documentText', () => ({ extractDocumentText: h.extractDocumentText }));
const message = (id: string) => ({ id, account_id: 'account-a', subject: `Example ${id}`, from_name: 'Example', from_address: 'sender@example.com', date: 0, snippet: `SNIPPET_${id}`, body_text: `FULL_BODY_${id}`, body_html_raw: '', to_list: [], cc_list: [] });
const structured = (overrides = {}) => JSON.stringify({ kind: 'chat', useMail: false, useKnowledge: false, useWeb: false, generateDraft: false, skillId: null, ...overrides });
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); h.mail.activeAccountId = 'account-a';
  h.extractDocumentText.mockResolvedValue('Example file fact');
  h.ui.homeContextQueue = []; h.ui.knowledgeContextQueue = []; h.ui.homeContextAttachmentQueue = [];
  h.api.aiPrompt.mockResolvedValue(structured()); h.api.aiChat.mockResolvedValue('EXAMPLE_ANSWER');
  h.api.agentRun.mockResolvedValue({ content: 'EXAMPLE_RESEARCH', sources: ['https://example.com/source'], toolCalls: 1 });
  h.api.mailAssistantRun.mockImplementation(async (request: any) => ({ content: 'EXAMPLE_ANSWER', sources: [], toolCalls: 1,
    mailReferences: request.explicitMessageIds.map((id: string) => ({ id, accountId: request.accountId, label: `Example ${id}`, subtitle: 'Example evidence', folderId: null })), knowledgeReferences: [], customerReferences: [],
    evidenceReport: { discoveredMailCount: request.explicitMessageIds.length, readMailCount: request.explicitMessageIds.length, completeMailCount: request.explicitMessageIds.length, resources: [], warnings: [], trace: [{ tool: 'mail_read', status: 'ok' }], budgetExhausted: false, toolFallback: false } }));
  h.api.listAccounts.mockResolvedValue([{ id: 'account-a' }, { id: 'account-b' }]); h.api.listFolders.mockResolvedValue([]);
  h.api.searchMessages.mockResolvedValue([]); h.api.listMessages.mockResolvedValue([]); h.api.getMessagesBatch.mockResolvedValue([]);
  h.api.listCustomerMemories.mockResolvedValue([]); h.api.searchKnowledgeBase.mockResolvedValue([]); h.api.listKnowledgeItems.mockResolvedValue([]);
});
afterEach(cleanup);
async function submit(prompt: string) {
  fireEvent.change(screen.getByRole('textbox', {name:'工作台指令'}), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '处理中', exact: true })).toBeNull());
}
const stored = () => JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');

describe('home mail secretary first-stage execution', () => {
  it('keeps a submitted instruction editable without sending it as mail', async () => {
    render(<HomeAiWorkbench />);
    await submit('Summarize the agreed delivery dates');
    fireEvent.click(screen.getByRole('button', { name: '再次编辑指令' }));
    expect((screen.getByRole('textbox', { name: '工作台指令' }) as HTMLTextAreaElement).value).toBe('Summarize the agreed delivery dates');
  });
  it('passes the end of a long explicitly supplied file to analysis without the old 22000-character packing cutoff', async () => {
    h.extractDocumentText.mockResolvedValue('X'.repeat(25_000) + '\nEND_OF_ARBITRARY_REFERENCE');
    render(<HomeAiWorkbench />);
    const file = new File(['fixture'], 'reference.txt');
    fireEvent.drop(screen.getByRole('textbox', { name: '工作台指令' }), {
      dataTransfer: { files: [], items: [{ kind: 'file', getAsFile: () => file }], getData: () => '' },
    });
    await submit('Summarize the supplied reference');
    expect(h.api.aiChat.mock.calls[0][0].at(-1).content).toContain('END_OF_ARBITRARY_REFERENCE');
    expect(h.api.aiChat.mock.calls[0][0].at(-1).content).toContain('已完整提取 1 个文件');
  });
  it('routes explicit split-to-drafts into a real action preview instead of a read-only refusal',async()=>{
    h.ui.homeContextQueue=[{messageId:'source',title:'Attached source'}];
    render(<HomeAiWorkbench/>);await submit('你帮我把这封邮件里的“写信”按钮拆开，成一封封邮件放到草稿箱里面');
    expect(h.api.mailAssistantRun).not.toHaveBeenCalled();expect(h.api.aiChat).not.toHaveBeenCalled();
    expect(screen.getByRole('region',{name:'拆分邮件并保存草稿'})).toBeTruthy();
    expect(stored()[0].messages.at(-1)).toMatchObject({task:{action:'extractDrafts'},actionSources:[{id:'source',title:'Attached source'}]});
  });
  it('keeps negated/conceptual outreach in chat even when the planner fails', async () => {
    h.api.aiPrompt.mockRejectedValue(new Error('Example offline'));
    render(<HomeAiWorkbench />); await submit('不要写开发信，只解释开发信是什么意思');
    expect(h.api.agentRun).not.toHaveBeenCalled(); expect(h.ui.openRightPanel).not.toHaveBeenCalled();
    expect(h.api.searchMessages).not.toHaveBeenCalled(); expect(h.api.listCustomerMemories).not.toHaveBeenCalled();
    expect(stored()[0].messages.at(-1).task.generateDraft).toBe(false);
  });
  it('generates an explicit draft inline with attached evidence; only user button opens editing', async () => {
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'writing', generateDraft: true }));
    h.ui.homeContextQueue = [{ messageId: 'selected', title: 'Selected example' }]; h.api.getMessagesBatch.mockResolvedValue([message('selected')]);
    render(<HomeAiWorkbench />); await submit('参考这封邮件，写一封确认交期的邮件');
    expect(screen.queryByRole('button',{name:/按文件.*指令生成草稿/})).toBeNull();
    expect(h.api.mailAssistantRun.mock.calls[0][0].explicitMessageIds).toEqual(['selected']);
    expect(h.api.aiChat).not.toHaveBeenCalled();
    expect(h.ui.openRightPanel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '编辑这份邮件草稿' }));
    expect(h.ui.openRightPanel).toHaveBeenCalledWith('aiWriting');
    expect(h.ui.setPendingAiWritingInstruction.mock.calls[0][0]).toContain('EXAMPLE_ANSWER');
  });
  it('retains mail identities across followups and component reload, with navigable references', async () => {
    h.ui.homeContextQueue = [{ messageId: 'selected', title: 'Selected example' }]; h.api.getMessagesBatch.mockResolvedValue([message('selected')]);
    let view = render(<HomeAiWorkbench />); await submit('综合这几封邮件给结论');
    expect(stored()[0].evidence).toEqual([{ kind: 'mail', id: 'selected', title: 'Selected example' }]);
    view.unmount(); h.ui.homeContextQueue = []; view = render(<HomeAiWorkbench />); await submit('再比较第二封');
    expect(h.api.mailAssistantRun).toHaveBeenCalledTimes(2);
    expect(h.api.mailAssistantRun.mock.calls[1][0].explicitMessageIds).toEqual(['selected']);
    expect(h.api.getMessagesBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Example selected', exact: true })[0]);
    expect(h.mail.setSearchScope).toHaveBeenCalledWith(null); expect(h.ui.openMessageInInbox).toHaveBeenCalledWith('selected');
    expect(h.ui.setMessageDetailId).toHaveBeenCalledWith('selected'); expect(h.ui.setActiveView).toHaveBeenCalledWith('messageDetail');
  });
  it('persists extracted file context for followups, without retaining binary File objects', async () => {
    const view = render(<HomeAiWorkbench />);
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(['example'], 'example.txt', { type: 'text/plain' })] } });
    await submit('分析这个文件');
    expect(stored()[0].evidence[0]).toMatchObject({ kind: 'file', title: 'example.txt', text: 'Example file fact' });
    await submit('刚才那份资料再分析一下'); expect(h.api.aiChat.mock.calls[1][0].at(-1).content).toContain('Example file fact');
  });
  it('does not mix conversations or selected evidence when switching accounts', async () => {
    const view = render(<HomeAiWorkbench />); await submit('请解释术语 A');
    h.mail.activeAccountId = 'account-b'; view.rerender(<HomeAiWorkbench />); await submit('请解释术语 B');
    const turns = h.api.aiChat.mock.calls[1][0]; expect(turns.some((turn: any) => turn.content === '请解释术语 A')).toBe(false);
    expect(stored().map((conversation: any) => conversation.accountId).sort()).toEqual(['account-a', 'account-b']);
    h.mail.activeAccountId = 'account-a'; view.rerender(<HomeAiWorkbench />); expect(screen.getByText('请解释术语 A')).toBeTruthy();
    h.mail.activeAccountId = null as any; view.rerender(<HomeAiWorkbench />);
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'mail', useMail: true }));
    await submit('整理当前邮箱'); expect(h.api.listAccounts).not.toHaveBeenCalled();
    expect(screen.getByText(/请先选择当前工作账户/)).toBeTruthy();
  });
  it('keeps failed input and attachment for retry without adding duplicate user turns', async () => {
    h.ui.homeContextQueue = [{ messageId: 'selected', title: 'Selected example' }]; h.api.getMessagesBatch.mockResolvedValue([message('selected')]);
    h.api.mailAssistantRun.mockRejectedValueOnce(new Error('Example model failure'));
    render(<HomeAiWorkbench />); await submit('分析这封邮件');
    expect((screen.getByRole('textbox', {name:'工作台指令'}) as HTMLTextAreaElement).value).toBe('分析这封邮件'); expect(stored()).toEqual([]);
    await submit('分析这封邮件'); expect(stored()[0].messages).toHaveLength(2); expect(stored()[0].evidence).toHaveLength(1);
  });
  it('uses real research tools for an ordinary online query and includes prior dialogue', async () => {
    render(<HomeAiWorkbench />); await submit('请解释术语 A');
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'research', useWeb: true }));
    await submit('请上网查询最新进口规定并给来源');
    expect(h.api.agentRun).toHaveBeenCalledOnce(); expect(h.api.agentRun.mock.calls[0][1]).toContain('请解释术语 A');
    expect(h.api.searchMessages).not.toHaveBeenCalled(); expect(screen.getByText(/联网来源 1 项/)).toBeTruthy();
  });
  it('labels research with no sources honestly', async () => {
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'research', useWeb: true }));
    h.api.agentRun.mockResolvedValue({ content: 'EXAMPLE_RESEARCH', sources: [], toolCalls: 0 });
    render(<HomeAiWorkbench />); await submit('查询最新公开资料');
    expect(screen.getByText(/未取得联网来源/)).toBeTruthy(); expect(screen.queryByText(/已启用联网核验/)).toBeNull();
  });
  it('does not let a late response from the old account overwrite new account results', async () => {
    let finishOld!: (value: string) => void;
    h.api.aiChat.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const view = render(<HomeAiWorkbench />);
    fireEvent.change(screen.getByRole('textbox', {name:'工作台指令'}), { target: { value: 'OLD_ACCOUNT_TASK' } }); fireEvent.click(screen.getByRole('button', { name: '发送', exact: true }));
    await waitFor(() => expect(h.api.aiChat).toHaveBeenCalledOnce());
    h.mail.activeAccountId = 'account-b'; view.rerender(<HomeAiWorkbench />); await submit('NEW_ACCOUNT_TASK');
    await act(async () => finishOld('OLD_ACCOUNT_RESULT'));
    expect(stored()).toHaveLength(1); expect(stored()[0].accountId).toBe('account-b'); expect(screen.queryByText('OLD_ACCOUNT_RESULT')).toBeNull();
  });
  it('preserves legacy history as read-only without feeding it into the new account', async () => {
    localStorage.setItem('yao-home-ai-conversations-v1', JSON.stringify([{ id: 'old', title: 'Old example', messages: [{ id: 'u', role: 'user', content: 'LEGACY_PRIVATE_CONTEXT', createdAt: 1 }], createdAt: 1, updatedAt: 1 }]));
    render(<HomeAiWorkbench />); await submit('请解释术语');
    expect(JSON.stringify(h.api.aiChat.mock.calls)).not.toContain('LEGACY_PRIVATE_CONTEXT');
    expect(stored().some((conversation: any) => conversation.legacy)).toBe(true);
  });
  it('waits for an async mail attachment before allowing submission', async () => {
    let finish!: (value: any) => void;
    h.ui.homeContextAttachmentQueue = [{ attachmentId: 'attachment', title: 'Example file' }];
    h.api.readAttachmentFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<HomeAiWorkbench />);
    fireEvent.change(screen.getByRole('textbox', {name:'工作台指令'}), { target: { value: '分析这份附件' } });
    expect((screen.getByRole('button', { name: '发送', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.api.aiPrompt).not.toHaveBeenCalled();
    await act(async () => finish({ bytes: [65], name: 'example.txt', mime_type: 'text/plain' }));
    await submit('分析这份附件'); expect(stored()[0].evidence[0].title).toBe('example.txt');
  });
  it('does not attach a late file response to a different account', async () => {
    let finish!: (value: any) => void;
    h.ui.homeContextAttachmentQueue = [{ attachmentId: 'attachment', title: 'Example file' }];
    h.api.readAttachmentFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<HomeAiWorkbench />); h.ui.homeContextAttachmentQueue = [];
    h.mail.activeAccountId = 'account-b'; view.rerender(<HomeAiWorkbench />);
    await act(async () => finish({ bytes: [65], name: 'old-account.txt', mime_type: 'text/plain' }));
    await submit('请解释术语'); expect(stored()[0].evidence).toEqual([]);
  });
  it('routes automatic mail analysis through the scoped evidence loop, not snippet ranking', async () => {
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'mail', useMail: true, useKnowledge: true }));
    render(<HomeAiWorkbench />); await submit('总结 Alpha 订单的全部往来');
    expect(h.api.mailAssistantRun.mock.calls[0][0]).toMatchObject({ accountId: 'account-a', allowMail: true, allowKnowledge: true, allowWeb: false });
    expect(h.api.searchMessages).not.toHaveBeenCalled(); expect(h.api.listMessages).not.toHaveBeenCalled();
    expect(screen.getByText(/取证范围：正文/)).toBeTruthy(); expect(stored()[0].messages.at(-1).evidenceReport).toBeTruthy();
  });
  it('followup references remain related account-bound IDs, not newly granted cross-account evidence', async () => {
    h.api.aiPrompt.mockResolvedValue(structured({ kind: 'mail', useMail: true }));
    h.api.mailAssistantRun.mockResolvedValue({ content: 'EXAMPLE_ANSWER', sources: [], toolCalls: 2, mailReferences: [{ id: 'old-a', accountId: 'account-a', label: 'Old order', subtitle: 'Example', folderId: null }], knowledgeReferences: [], customerReferences: [], evidenceReport: { discoveredMailCount: 1, readMailCount: 1, completeMailCount: 1, resources: [], warnings: [], trace: [], budgetExhausted: false, toolFallback: false } });
    render(<HomeAiWorkbench />); await submit('总结这个订单'); await submit('它后面怎么说？');
    expect(h.api.mailAssistantRun.mock.calls[1][0].relatedMessageIds).toEqual(['old-a']);
    expect(h.api.mailAssistantRun.mock.calls[1][0].explicitMessageIds).toEqual([]);
  });
  it('opens an inline citation only when the result contains a verified reference', async () => {
    h.ui.homeContextQueue = [{ messageId: 'selected', title: 'Selected example' }];
    h.api.mailAssistantRun.mockImplementation(async (request: any) => ({ content: 'CITE_TEST', sources: [], toolCalls: 1, mailReferences: [{ id: 'selected', accountId: request.accountId, label: 'Example selected', subtitle: 'Read evidence', folderId: null }], knowledgeReferences: [], customerReferences: [], evidenceReport: { discoveredMailCount: 1, readMailCount: 1, completeMailCount: 1, resources: [], warnings: [], trace: [], budgetExhausted: false, toolFallback: false } }));
    render(<HomeAiWorkbench />); await submit('分析这封邮件');
    fireEvent.click(screen.getByRole('link', { name: 'Inline source' })); expect(h.ui.setMessageDetailId).toHaveBeenCalledWith('selected');
    fireEvent.click(screen.getByRole('link', { name: 'Forged source' })); expect(h.ui.setMessageDetailId).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/引用没有实际读取证据/)).toBeTruthy();
  });
  it('preserves outreach hard constraints when mail tools and web research are combined', async () => {
    h.api.aiPrompt.mockResolvedValueOnce(structured({ kind: 'writing', useMail: true, useWeb: true, generateDraft: true, skillId: 'research-first-outreach' }))
      .mockResolvedValueOnce('## 邮件正文\nHello example team,\nCould a sample selection help?\n\n## 发送前确认\n核对产品。');
    render(<HomeAiWorkbench />); await submit('研究这个客户，结合往来帮我写一封开发信');
    expect(h.api.mailAssistantRun).toHaveBeenCalledOnce(); expect(h.api.aiPrompt).toHaveBeenCalledTimes(2);
    expect(stored()[0].messages.at(-1).content).toContain('## 邮件正文'); expect(h.ui.openRightPanel).not.toHaveBeenCalled();
  });
  it('retains the request if outreach constraint repair still produces an invalid result', async () => {
    h.api.aiPrompt.mockResolvedValueOnce(structured({ kind: 'writing', useMail: true, useWeb: true, generateDraft: true, skillId: 'research-first-outreach' }))
      .mockResolvedValueOnce('仍然没有邮件正文标题');
    render(<HomeAiWorkbench />); await submit('研究这个客户，结合往来帮我写一封开发信');
    expect(stored()).toEqual([]); expect((screen.getByRole('textbox', {name:'工作台指令'}) as HTMLTextAreaElement).value).toContain('写一封开发信');
    expect(screen.getByText(/仍不符合安全约束/)).toBeTruthy();
  });
});
