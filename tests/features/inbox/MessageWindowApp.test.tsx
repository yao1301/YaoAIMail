import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MessageWindowApp, { readWindowMessageId } from '../../../src/features/inbox/MessageWindowApp';
import { useMailStore } from '../../../src/stores/mail.store';
import { WorkspaceStateScope, trackWorkspaceSource } from '../../../src/lib/workspaceState';

const h = vi.hoisted(()=>({close:vi.fn(),hide:vi.fn(),destroy:vi.fn(),confirm:vi.fn(),invalidate:vi.fn(),unlisten:vi.fn(),activate:vi.fn(),dirty:false,
  onClose:null as null|((event:{preventDefault:()=>void})=>Promise<void>),
  ui:{activeView:'messageDetail',messageDetailId:null as string|null,theme:'light',fontFamily:'system',fontScale:1,rightPanelOpen:false,navTabs:[]},
  tabs:[] as Array<{id:string}>,activeCompose:null as string|null}));
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({close:h.close,hide:h.hide,destroy:h.destroy,onCloseRequested:async (fn:typeof h.onClose)=>{h.onClose=fn;return h.unlisten;}})}));
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:h.invalidate})}));
vi.mock('../../../src/hooks/queries',()=>({useMessageQuery:()=>({data:{account_id:'account-a'}})}));
vi.mock('../../../src/stores/ui.store',()=>({useUIStore:Object.assign((s:any)=>s(h.ui),{setState:(v:any)=>Object.assign(h.ui,v),getState:()=>({setActiveView:(view:string)=>{h.ui.activeView=view;}})}),applyThemeToDom:vi.fn(),applyTypographyToDom:vi.fn()}));
vi.mock('../../../src/stores/compose.store',()=>({isComposeDirty:()=>h.dirty,useComposeStore:Object.assign((s:any)=>s({tabs:h.tabs,activeTabId:h.activeCompose}),{getState:()=>({tabs:h.tabs,composeDirty:h.dirty,activateComposeTab:h.activate})})}));
vi.mock('../../../src/stores/confirm.store',()=>({useConfirmStore:{getState:()=>({confirm:h.confirm})}}));
vi.mock('../../../src/components/TitleBar',()=>({default:()=> <div>Window titlebar</div>}));
vi.mock('../../../src/components/WorkspaceTabs',()=>({default:()=> <div>Window tabs</div>}));
vi.mock('../../../src/components/ToastContainer',()=>({default:()=>null}));
vi.mock('../../../src/features/translate/SelectionTranslateOverlay',()=>({default:()=>null}));
vi.mock('../../../src/features/compose/ComposeWindowConfirm',()=>({ComposeWindowConfirm:()=>null}));
vi.mock('../../../src/features/compose/ComposeView',()=>({default:({tabId}:{tabId:string})=><div data-testid={`draft-${tabId}`}>Editable draft</div>}));
vi.mock('../../../src/components/MessageDetail',()=>({default:({messageId,onBack}:{messageId:string;onBack:()=>void})=><div>Mail {messageId}<button onClick={onBack}>Close mail</button></div>}));

beforeEach(()=>{
  vi.clearAllMocks(); h.dirty=false; h.onClose=null;h.tabs=[];h.activeCompose=null;
  h.ui.activeView='messageDetail';h.ui.messageDetailId=null;
  h.confirm.mockResolvedValue(false);
  useMailStore.setState({openMessageIds:[],selectedMessageId:null,activeAccountId:null});
  window.history.replaceState({},'', '/?mailWindow=1&message=bTE');
});
afterEach(()=>{cleanup();window.history.replaceState({},'','/');});
it('decodes only an opaque mail id, including UTF-8, and rejects invalid input',()=>{
  expect(readWindowMessageId('?message=bTE')).toBe('m1');
  expect(readWindowMessageId('?message=6YKu5Lu2')).toBe('邮件');
  expect(readWindowMessageId('?message=%%%')).toBeNull();expect(readWindowMessageId('')).toBeNull();
  expect(readWindowMessageId('?message='+ 'a'.repeat(3000))).toBeNull();
});
it('opens the same message renderer with the correct account, not an empty main layout',async()=>{
  render(<MessageWindowApp/>);await act(async()=>{});
  expect(screen.getByText('Mail m1')).toBeTruthy();
  expect(useMailStore.getState().activeAccountId).toBe('account-a');
  expect(useMailStore.getState().selectedMessageId).toBe('m1');
  expect(useMailStore.getState().openMessageIds).toContain('m1');
  fireEvent.click(screen.getByRole('button',{name:'Close mail'}));expect(h.close).toHaveBeenCalled();
});
it('keeps compose tabs mounted when returning to read mail',()=>{
  h.tabs=[{id:'draft-1'}];h.activeCompose='draft-1';
  const view=render(<MessageWindowApp/>);
  expect(screen.getByTestId('draft-draft-1').closest('[data-workspace-id]')?.parentElement?.style.display).toBe('none');
  h.ui.activeView='compose';view.rerender(<MessageWindowApp/>);
  expect(screen.getByTestId('draft-draft-1').closest('[data-workspace-id]')?.parentElement?.style.display).toBe('block');
  expect(screen.queryByText('Mail m1')).toBeNull();
});
it('protects unsaved drafts on native close and destroys only after confirmation',async()=>{
  render(<MessageWindowApp/>);await act(async()=>{});h.dirty=true;
  const preventDefault=vi.fn();
  await act(async()=>{await h.onClose?.({preventDefault});});
  expect(preventDefault).toHaveBeenCalled();expect(h.destroy).not.toHaveBeenCalled();
  h.confirm.mockResolvedValue(true);
  await act(async()=>{await h.onClose?.({preventDefault});});
  expect(h.destroy).toHaveBeenCalledTimes(1);
});
it('keeps the callback owner alive after its draft moved to another window',async()=>{
  vi.useFakeTimers();
  const scope=new WorkspaceStateScope({'draft:aiGenerating':true});
  const release=trackWorkspaceSource(scope);
  try {
    render(<MessageWindowApp/>);await act(async()=>{});
    const preventDefault=vi.fn();
    await act(async()=>{await h.onClose?.({preventDefault});});
    expect(preventDefault).toHaveBeenCalled();expect(h.hide).toHaveBeenCalledTimes(1);
    expect(h.destroy).not.toHaveBeenCalled();
    scope.write('draft:aiGenerating',false);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(h.destroy).toHaveBeenCalledTimes(1);
  } finally {release();vi.useRealTimers();}
});
it('has a visible error and removes splash even for an invalid window link',()=>{
  window.history.replaceState({},'','/?mailWindow=1&message=%%%');
  const splash=document.createElement('div');splash.id='splash';document.body.append(splash);
  render(<MessageWindowApp/>);expect(screen.getByRole('alert').textContent).toContain('参数无效');
  expect(document.getElementById('splash')).toBeNull();
});
it('closes the standalone window when its last mail tab closes, not on initial mount',async()=>{
  render(<MessageWindowApp/>);await act(async()=>{});
  expect(h.close).not.toHaveBeenCalled();
  act(()=>useMailStore.getState().closeMessageTab('m1'));
  expect(h.close).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Mail m1')).toBeNull();
});
it('keeps the window and activates an existing draft when its last mail tab closes',async()=>{
  h.tabs=[{id:'draft-1'}];h.activeCompose='draft-1';
  render(<MessageWindowApp/>);await act(async()=>{});
  act(()=>useMailStore.getState().closeMessageTab('m1'));
  expect(h.close).not.toHaveBeenCalled();expect(h.activate).toHaveBeenCalledWith('draft-1');
});
