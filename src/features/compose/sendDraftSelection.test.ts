import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDraftSelection } from './sendDraftSelection';
const h=vi.hoisted(()=>({get:vi.fn(),files:vi.fn(),guard:vi.fn(),config:vi.fn(),send:vi.fn(),confirm:vi.fn(),accounts:vi.fn(),path:vi.fn()}));
vi.mock('@/lib/api',()=>({getMessage:h.get,listAttachments:h.files,checkSendGuard:h.guard,getSendGuardConfig:h.config,sendSavedDraft:h.send,listAccounts:h.accounts,getAttachmentPath:h.path}));
const draft=(id='one')=>({id,account_id:'account',remote_id:'',is_draft:true,is_deleted:false,updated_at:123,subject:`Subject ${id}`,body_text:'Body',body_html_raw:'<table><tr><td>Original table</td></tr></table>',to_list:[{address:'buyer@example.test'}],cc_list:[],bcc_list:[],has_attachments:false});
beforeEach(()=>{vi.clearAllMocks();h.get.mockImplementation(async(id:string)=>draft(id));h.files.mockResolvedValue([]);h.config.mockResolvedValue({enabled:true});h.guard.mockResolvedValue({level:'ok',reasons:[]});h.send.mockResolvedValue('operation');h.confirm.mockResolvedValue(true);h.accounts.mockResolvedValue([{id:'account',email:'sender@example.test'}]);h.path.mockResolvedValue('/fixture/file');});
describe('draft single/batch sending confirmation pipeline',()=>{
  it('prepares every draft, keeps revision and sends only after one explicit confirmation',async()=>{
    let release:(value:boolean)=>void=()=>{};h.confirm.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const work=sendDraftSelection(['one','two','one'],h.confirm);
    await vi.waitFor(()=>expect(h.confirm).toHaveBeenCalledOnce());expect(h.send).not.toHaveBeenCalled();
    expect(h.confirm.mock.calls[0][0].message).toContain('Subject two');release(true);
    expect((await work)?.queuedIds).toEqual(['one','two']);expect(h.send).toHaveBeenNthCalledWith(1,'account','one',123);expect(h.send).toHaveBeenCalledTimes(2);
  });
  it('cancelling the confirmation never enqueues anything',async()=>{
    h.confirm.mockResolvedValue(false);expect(await sendDraftSelection(['one'],h.confirm)).toBeNull();expect(h.send).not.toHaveBeenCalled();
  });
  it('invalid recipient in any draft stops the entire preflight before sending',async()=>{
    h.get.mockImplementation(async(id:string)=>id==='two'?{...draft(id),to_list:[]}:draft(id));
    await expect(sendDraftSelection(['one','two'],h.confirm)).rejects.toThrow('邮箱');expect(h.confirm).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  });
  it('rejects non-drafts, missing body and missing attachments',async()=>{
    for(const patch of [{is_draft:false},{body_text:'',body_html_raw:''},{has_attachments:true}]){
      h.get.mockResolvedValue({...draft(),...patch});await expect(sendDraftSelection(['one'],h.confirm)).rejects.toThrow();
    }
    expect(h.send).not.toHaveBeenCalled();
  });
  it('checks guarded risks, blocks high risk and displays warnings in confirmation',async()=>{
    h.guard.mockResolvedValueOnce({level:'block',reasons:['Unconfirmed amount']});
    await expect(sendDraftSelection(['one'],h.confirm)).rejects.toThrow('Unconfirmed amount');expect(h.send).not.toHaveBeenCalled();
    h.guard.mockResolvedValueOnce({level:'warn',reasons:['Check payment terms']});
    await sendDraftSelection(['one'],h.confirm);expect(h.confirm.mock.calls[0][0].message).toContain('Check payment terms');
  });
  it('another toolbar cannot duplicate an in-progress send, and lock is released after cancel',async()=>{
    let release:(value:boolean)=>void=()=>{};h.confirm.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const work=sendDraftSelection(['one'],h.confirm);await vi.waitFor(()=>expect(h.confirm).toHaveBeenCalled());
    await expect(sendDraftSelection(['one'],h.confirm)).rejects.toThrow('正在处理');release(false);await work;
    await sendDraftSelection(['one'],h.confirm);expect(h.send).toHaveBeenCalledOnce();
  });
  it('returns per-draft queue failures without replaying a successful submission',async()=>{
    h.send.mockRejectedValueOnce(new Error('stale revision'));
    const result=await sendDraftSelection(['one','two'],h.confirm);
    expect(result).toEqual({queuedIds:['two'],failed:[{id:'one',subject:'Subject one',error:'stale revision'}]});expect(h.send).toHaveBeenCalledTimes(2);
  });
  it('remote drafts use the same revision-checked native entry, not a second frontend transport',async()=>{
    h.get.mockResolvedValue({...draft(),remote_id:'provider-message'});await sendDraftSelection(['one'],h.confirm);expect(h.send).toHaveBeenCalledWith('account','one',123);
  });
});
