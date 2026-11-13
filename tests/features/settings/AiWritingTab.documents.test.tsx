import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiWritingTab from '../../../src/features/settings/AiWritingTab';
const h = vi.hoisted(() => ({
  api: Object.fromEntries(['listStyleProfiles','saveStyleProfile','deleteStyleProfile','getSentSamples','listCustomerMemories','listThreadMessages','searchKnowledgeBase','listKnowledgeItems','listAddressBookContacts','aiPrompt','getMessagesBatch','readAttachmentFile'].map(key => [key, vi.fn()])),
  accounts: [{ id: 'one', email: 'me@example.test', display_name: 'Fixture' }],
  compose: { activeDraftContext: null, composeReplyTo: null, activeTabId: null, openCompose: vi.fn() },
  ui: { activeView: 'home', pendingAiWritingInstruction: null, aiContextQueue: [], aiContextAttachmentQueue: [], knowledgeContextQueue: [], aiWritingTurns: [], setAiWritingTurns: vi.fn(), setAiBgTask: vi.fn(), setAiInputFocusOwner: vi.fn() },
  extract: vi.fn(), toast: vi.fn(),
}));
vi.mock('@/lib/api', () => h.api);
vi.mock('@/lib/documentText', () => ({ extractDocumentText: h.extract }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/queries', () => ({ useAccountsQuery: () => ({ data: h.accounts }), useMessageQuery: () => ({ data: null }) }));
vi.mock('@/stores/mail.store', () => ({ useMailStore: (selector: (state: unknown) => unknown) => selector({ activeAccountId: 'one', selectedMessageId: null }) }));
vi.mock('@/stores/compose.store', () => ({ useComposeStore: Object.assign((selector: (state: unknown) => unknown) => selector(h.compose), { getState: () => h.compose }) }));
vi.mock('@/stores/ui.store', () => ({ useUIStore: Object.assign((selector: (state: unknown) => unknown) => selector(h.ui), { getState: () => h.ui }) }));
vi.mock('@/stores/toast.store', () => ({ useToastStore: { getState: () => ({ addToast: h.toast }) } }));
vi.mock('@/lib/signatures', () => ({ getSignature: vi.fn().mockResolvedValue(''), listEmailSignatures: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/writingPreferences', () => ({ getWritingPreferences: () => ({ language: 'auto', includeKnowledge: false, styleProfileId: '', signatureId: '' }), saveWritingPreferences: vi.fn() }));
vi.mock('@/features/settings/WorkRoleTab', () => ({ getActiveWorkRole: () => null }));
vi.mock('@/components/KnowledgePicker', () => ({ default: () => null }));
vi.mock('@/components/AccountScopePicker', () => ({ default: () => null }));
vi.mock('@/components/AccountScopeSelect', () => ({ default: () => null }));
beforeEach(() => {
  vi.clearAllMocks(); h.api.listStyleProfiles.mockResolvedValue([]); h.api.listCustomerMemories.mockResolvedValue([]); h.api.listAddressBookContacts.mockResolvedValue([]);
  h.api.aiPrompt.mockResolvedValue('Dear buyer,\nThe quoted price is EUR 112.50.'); h.extract.mockResolvedValue('a'.repeat(15_000) + '\nFinal price EUR 112.50');
});
afterEach(cleanup);
describe('AI writing document entry', () => {
  it('shows the consent warning next to the learn style button', async () => {
    render(<AiWritingTab />);
    const button = screen.getByRole('button', { name: 'aiWriting.learnButton' });
    await act(async () => { fireEvent.click(button); });
    const warning = screen.getByRole('alert');
    expect(warning.textContent).toContain('请先确认允许');
    expect(warning.parentElement).toBe(button.parentElement);
    expect(h.api.getSentSamples).not.toHaveBeenCalled();
  });
  it('delivers a slow completed generation even after its writing panel unmounts', async () => {
    let finish!: (answer: string) => void;
    h.api.aiPrompt.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<AiWritingTab quick />);
    fireEvent.change(screen.getByPlaceholderText('aiWriting.instructionPlaceholder'), { target: { value: 'Prepare a revised offer' } });
    fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' }));
    await waitFor(() => expect(h.api.aiPrompt).toHaveBeenCalled());
    unmount();
    await act(async () => { finish('Dear buyer, here is the revised offer.'); });
    expect(h.compose.openCompose).toHaveBeenCalledWith('new', null, expect.objectContaining({ body: 'Dear buyer, here is the revised offer.', accountId: 'one' }));
    expect(h.ui.setAiBgTask).toHaveBeenLastCalledWith(expect.objectContaining({ running: false, result: expect.any(String) }));
  });
  it('retains the original instruction in history with an explicit edit action', async () => {
    render(<AiWritingTab quick />);
    const input = screen.getByPlaceholderText('aiWriting.instructionPlaceholder');
    fireEvent.change(input, { target: { value: 'Prepare a revised offer' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' })); });
    await waitFor(() => expect(h.compose.openCompose).toHaveBeenCalled());
    expect((input as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '再次编辑' }));
    expect((input as HTMLTextAreaElement).value).toBe('Prepare a revised offer');
  });
  it('restores the corresponding prompt on undo and redo without generating again', async () => {
    render(<AiWritingTab quick />);
    const input = screen.getByPlaceholderText('aiWriting.instructionPlaceholder');
    fireEvent.change(input, { target: { value: 'First instruction' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' })); });
    fireEvent.change(input, { target: { value: 'Second instruction' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' })); });
    fireEvent.click(screen.getByRole('button', { name: /撤销到上一步/ }));
    expect((input as HTMLTextAreaElement).value).toBe('First instruction');
    fireEvent.click(screen.getByRole('button', { name: /恢复到下一步/ }));
    expect((input as HTMLTextAreaElement).value).toBe('Second instruction');
    expect(h.api.aiPrompt).toHaveBeenCalledTimes(2);
  });
  it('waits for dragged attachment bytes before allowing generation', async () => {
    let finish!: (value: unknown) => void;
    h.api.readAttachmentFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<AiWritingTab quick />);
    const input = screen.getByPlaceholderText('aiWriting.instructionPlaceholder');
    fireEvent.change(input, { target: { value: 'Draft from the supplied reference' } });
    fireEvent.drop(input, { dataTransfer: { files: [], items: [], getData: (type: string) => type === 'application/x-pebble-attachment-id' ? 'attachment-1' : '' } });
    expect((screen.getByRole('button', { name: 'aiWriting.generateButton' }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.api.aiPrompt).not.toHaveBeenCalled();
    await act(async () => { finish({ name: 'reference.txt', bytes: [65], mime_type: 'text/plain' }); });
    fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' }));
    await waitFor(() => expect(h.api.aiPrompt).toHaveBeenCalled());
    expect(h.api.aiPrompt.mock.calls[0][1]).toContain('Final price EUR 112.50');
  });
  it('reads a directly dropped document through the shared items-only transfer path', async () => {
    render(<AiWritingTab quick />);
    const input = screen.getByPlaceholderText('aiWriting.instructionPlaceholder');
    fireEvent.drop(input, { dataTransfer: { files: [], items: [{ kind: 'file', getAsFile: () => new File(['fixture'], 'reference.docx') }], getData: () => '' } });
    fireEvent.change(input, { target: { value: 'Use the reference to draft an update' } });
    fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' }));
    await waitFor(() => expect(h.api.aiPrompt).toHaveBeenCalled());
    expect(h.api.aiPrompt.mock.calls[0][1]).toContain('Final price EUR 112.50');
    expect(h.api.aiPrompt.mock.calls[0][1]).toContain('已完整提取 1 个文件');
  });
  async function attachAndGenerate() {
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, { target: { files: [new File(['fixture'], 'quote.xlsx')] } });
    fireEvent.change(screen.getByPlaceholderText('aiWriting.instructionPlaceholder'), { target: { value: '根据报价表写邮件' } });
    fireEvent.click(screen.getByRole('button', { name: 'aiWriting.generateButton' }));
  }
  it('keeps the familiar generation command and sends actual file text past 12000 characters', async () => {
    render(<AiWritingTab quick />); await attachAndGenerate();
    await waitFor(() => expect(h.compose.openCompose).toHaveBeenCalled());
    expect(h.api.aiPrompt.mock.calls[0][1]).toContain('Final price EUR 112.50');
    expect(h.compose.openCompose.mock.calls[0][0]).toBe('new');
    expect(screen.queryByRole('button', { name: /按文件／指令生成草稿/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('blocks an unreadable file rather than generating from its filename', async () => {
    h.extract.mockResolvedValue(''); render(<AiWritingTab quick />); await attachAndGenerate();
    await screen.findByRole('alert'); expect(h.api.aiPrompt).not.toHaveBeenCalled(); expect(h.compose.openCompose).not.toHaveBeenCalled();
    expect(screen.getByText('文件：quote.xlsx')).toBeTruthy();
  });
});
