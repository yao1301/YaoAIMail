import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import WorkbenchActions from '../../../src/features/home/WorkbenchActions';
const h=vi.hoisted(()=>({api:Object.fromEntries(['previewWorkbenchMailtoDrafts','commitWorkbenchDrafts','scheduleWorkbenchDraft','cancelWorkbenchSchedule','getMessage','listAttachments','checkSendGuard','updateMessageFlags','archiveMessage','listFolders','moveToFolder'].map(k=>[k,vi.fn()])),invalidate:vi.fn(),open:vi.fn()}));
vi.mock('../../../src/lib/api',()=>h.api);
vi.mock('@tanstack/react-query',()=>({useQueryClient:()=>({invalidateQueries:h.invalidate})}));
vi.mock('../../../src/features/compose/reopenMessage',()=>({loadMessageForEditing:vi.fn().mockResolvedValue({})}));
vi.mock('../../../src/stores/compose.store',()=>({useComposeStore:{getState:()=>({openDraft:h.open})}}));
vi.mock('../../../src/stores/mail.store',()=>({useMailStore:{getState:()=>({setActiveAccountId:vi.fn(),setActiveFolderId:vi.fn(),setSearchScope:vi.fn()})}}));
vi.mock('../../../src/stores/ui.store',()=>({useUIStore:{getState:()=>({setActiveView:vi.fn()})}}));
const item=(key:string)=>({key,to:[`${key}@example.test`],cc:[],bcc:[],subject:`Subject ${key}`,bodyText:`Original body ${key}`});
const props={accountId:'one',sourceMessages:[{id:'source',title:'Original mail'}],requestId:'request',action:'extractDrafts' as const};
const draft={id:'draft',account_id:'one',remote_id:'__local_draft__:draft',is_draft:true,is_deleted:false,subject:'Fixture',body_text:'Body',body_html_raw:'<p>Body</p>',to_list:[{address:'buyer@example.test',name:null}],cc_list:[],bcc_list:[],updated_at:123};
beforeEach(()=>{vi.clearAllMocks();h.invalidate.mockResolvedValue(undefined);h.api.previewWorkbenchMailtoDrafts.mockResolvedValue({accountId:'one',sourceId:'source',sourceUpdatedAt:1,sourceTitle:'Original mail',items:[item('a'),item('b')],warnings:[]});h.api.commitWorkbenchDrafts.mockResolvedValue([{key:'a',draftId:'draft',created:true,exists:true}]);h.api.getMessage.mockResolvedValue(draft);h.api.listAttachments.mockResolvedValue([]);h.api.checkSendGuard.mockResolvedValue({level:'ok',reasons:[]});h.api.scheduleWorkbenchDraft.mockResolvedValue('op');h.api.cancelWorkbenchSchedule.mockResolvedValue('draft');});
afterEach(cleanup);
describe('workbench explicit action gate',()=>{
  it('preview reads the complete source but does not create or send anything',async()=>{
    render(<WorkbenchActions {...props}/>);
    fireEvent.click(screen.getByRole('button',{name:'读取完整写信链接并预览'}));
    await screen.findByText('Subject a');
    expect(h.api.previewWorkbenchMailtoDrafts).toHaveBeenCalledWith('one','source');
    expect(h.api.commitWorkbenchDrafts).not.toHaveBeenCalled();expect(h.api.scheduleWorkbenchDraft).not.toHaveBeenCalled();
    expect((screen.getByRole('button',{name:'确认保存选中的 2 份草稿'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('requires selecting one source instead of silently mixing several mails',async()=>{
    render(<WorkbenchActions {...props} sourceMessages={[...props.sourceMessages,{id:'other',title:'Other mail'}]}/>);
    fireEvent.click(screen.getByRole('button',{name:'读取完整写信链接并预览'}));
    expect((await screen.findByRole('alert')).textContent).toContain('请选择本次');expect(h.api.previewWorkbenchMailtoDrafts).not.toHaveBeenCalled();
  });
  it('only commits selected rows after confirmation and double click cannot duplicate',async()=>{
    let finish:(value:any)=>void=()=>{};h.api.commitWorkbenchDrafts.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    render(<WorkbenchActions {...props}/>);fireEvent.click(screen.getByRole('button',{name:'读取完整写信链接并预览'}));await screen.findByText('Subject a');
    fireEvent.click(screen.getByRole('checkbox',{name:'Subject b'}));
    fireEvent.click(screen.getByRole('checkbox',{name:/我已核对收件人和正文/}));
    const save=screen.getByRole('button',{name:'确认保存选中的 1 份草稿'});fireEvent.click(save);fireEvent.click(save);
    expect(h.api.commitWorkbenchDrafts).toHaveBeenCalledTimes(1);
    expect(h.api.commitWorkbenchDrafts.mock.calls[0][0]).toMatchObject({accountId:'one',sourceId:'source',requestId:'request',items:[item('a')]});
    await act(async()=>finish([{key:'a',draftId:'draft',created:true,exists:true}]));
    expect((await screen.findByText(/新保存 1 份/)).textContent).toContain('没有发送');
  });
  it('late preview from another account never appears in the new account',async()=>{
    let finish:(value:any)=>void=()=>{};h.api.previewWorkbenchMailtoDrafts.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const view=render(<WorkbenchActions {...props}/>);fireEvent.click(screen.getByRole('button',{name:'读取完整写信链接并预览'}));
    view.rerender(<WorkbenchActions {...props} accountId="two"/>);
    await act(async()=>finish({accountId:'one',sourceId:'source',sourceUpdatedAt:1,items:[item('a')],warnings:[]}));
    expect(screen.queryByText('Subject a')).toBeNull();expect(h.api.commitWorkbenchDrafts).not.toHaveBeenCalled();
  });
  it('saves an editable candidate only as a draft and retains failure input',async()=>{
    h.api.commitWorkbenchDrafts.mockRejectedValue(new Error('fixture write failure'));
    render(<WorkbenchActions {...props} action="saveDraft" initialContent="Candidate body"/>);
    fireEvent.change(screen.getByLabelText('草稿收件邮箱'),{target:{value:'buyer@example.test'}});
    fireEvent.change(screen.getByLabelText('草稿主题'),{target:{value:'Candidate subject'}});
    fireEvent.click(screen.getByRole('checkbox',{name:/我已核对收件人和正文/}));fireEvent.click(screen.getByRole('button',{name:'确认保存草稿'}));
    expect((await screen.findByRole('alert')).textContent).toContain('fixture write failure');
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('Candidate body');
    expect(h.api.scheduleWorkbenchDraft).not.toHaveBeenCalled();
  });
  it('schedules exactly the displayed revision after risk and time confirmation, then can cancel',async()=>{
    render(<WorkbenchActions {...props} action="schedule" sourceMessages={[{id:'draft',title:'Saved draft'}]}/>);
    fireEvent.change(screen.getByLabelText('定时草稿'),{target:{value:'draft'}});fireEvent.click(screen.getByRole('button',{name:'读取草稿预览'}));
    await screen.findByText('Fixture');expect(h.api.scheduleWorkbenchDraft).not.toHaveBeenCalled();
    const at=new Date(Date.now()+3_600_000);const local=new Date(at.getTime()-at.getTimezoneOffset()*60_000).toISOString().slice(0,16);
    fireEvent.change(screen.getByLabelText('计划发送时间'),{target:{value:local}});
    fireEvent.click(screen.getByRole('button',{name:'检查发送风险'}));await screen.findByText('风险检查通过');
    fireEvent.click(screen.getByRole('checkbox',{name:/已核对本草稿/}));fireEvent.click(screen.getByRole('button',{name:'确认定时发送这份草稿'}));
    await waitFor(()=>expect(h.api.scheduleWorkbenchDraft).toHaveBeenCalledWith('one','draft',123,Math.floor(new Date(local).getTime()/1000)));
    const cancel=await screen.findByRole('button',{name:'取消此定时任务并恢复草稿'});fireEvent.click(cancel);
    await waitFor(()=>expect(h.api.cancelWorkbenchSchedule).toHaveBeenCalledWith('one','op'));
    expect(h.api.commitWorkbenchDrafts).not.toHaveBeenCalled();
  });
  it('blocks scheduling if the preview belongs to a different account',async()=>{
    h.api.getMessage.mockResolvedValue({...draft,account_id:'two'});
    render(<WorkbenchActions {...props} action="schedule" sourceMessages={[{id:'draft',title:'Saved draft'}]}/>);
    fireEvent.change(screen.getByLabelText('定时草稿'),{target:{value:'draft'}});fireEvent.click(screen.getByRole('button',{name:'读取草稿预览'}));
    expect((await screen.findByRole('alert')).textContent).toContain('当前账户');expect(h.api.scheduleWorkbenchDraft).not.toHaveBeenCalled();
  });
  it('organizing requires exact mail selection and confirmation',async()=>{
    h.api.getMessage.mockResolvedValue({...draft,id:'source',is_draft:false});h.api.updateMessageFlags.mockResolvedValue(undefined);
    render(<WorkbenchActions {...props} action="organize"/>);
    expect(h.api.updateMessageFlags).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox',{name:'Original mail'}));fireEvent.click(screen.getByRole('checkbox',{name:/确认对选中的 1 封/}));
    fireEvent.click(screen.getByRole('button',{name:'确认执行邮件整理'}));
    await waitFor(()=>expect(h.api.updateMessageFlags).toHaveBeenCalledWith('source',true,undefined));
  });
});
