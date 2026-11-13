import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({load:vi.fn(),pre:vi.fn(),verify:vi.fn(),status:vi.fn(),confirm:vi.fn(),feedback:vi.fn(),listener:undefined as undefined|(()=>void)}));
vi.mock('@tauri-apps/api/event',()=>({listen:async(_name:string,fn:()=>void)=>{h.listener=fn;return()=>{h.listener=undefined;};}}));
vi.mock('@/lib/api',()=>({loadResearchEmailChecks:h.load,prescreenResearchEmails:h.pre,verifyResearchEmail:h.verify,getExternalServiceKeyStatus:h.status,recordResearchEmailFeedback:h.feedback}));
vi.mock('@/stores/confirm.store',()=>({useConfirmStore:{getState:()=>({confirm:h.confirm})}}));
import {EmailVerificationScope,EmailVerificationSelect,MailboxCheckInfo,useMailboxPresentation} from './EmailVerificationPanel';
import {useEmailChecks} from '@/stores/emailChecks.store';
import {useMailStore} from '@/stores/mail.store';
import {useUIStore} from '@/stores/ui.store';
function Row({email}:{email:string}){const {presentation}=useMailboxPresentation(email,[]);return <div><EmailVerificationSelect email={email}/><span>{email}</span><span>{presentation.deliveryLabel}</span><MailboxCheckInfo email={email}/></div>;}
function panel(emails:string[]){return render(<EmailVerificationScope emails={emails}>{emails.map(e=><Row key={e} email={e}/>)}</EmailVerificationScope>);}
describe('free screening and explicit verification',()=>{
 beforeEach(()=>{vi.resetAllMocks();useEmailChecks.setState({records:{},busy:false,screening:false,error:'',progress:''});h.load.mockResolvedValue({});h.pre.mockResolvedValue({});h.status.mockResolvedValue({hunterConfigured:true});h.confirm.mockResolvedValue(true);h.verify.mockImplementation(async(email:string)=>({email,deliveryStatus:'valid',verificationProvider:'Hunter',checkedAt:123,reason:'验证服务通过'}));});
 afterEach(async()=>{await act(async()=>{});cleanup();});
 it('automatically screens but never spends Hunter credits on mount',async()=>{panel(['first@example.org']);await waitFor(()=>expect(h.pre).toHaveBeenCalledWith(['first@example.org']));expect(h.verify).not.toHaveBeenCalled();});
 it('verifies only selected mailboxes after confirmation',async()=>{panel(['one@example.org','two@example.org']);fireEvent.click(screen.getByRole('checkbox',{name:'选择验证 two@example.org'}));fireEvent.click(screen.getByRole('button',{name:'验证选中（1）'}));await waitFor(()=>expect(h.verify).toHaveBeenCalledWith('two@example.org',false));expect(h.verify).toHaveBeenCalledTimes(1);expect(h.confirm).toHaveBeenCalled();});
 it('excludes hard failures from bulk verification',async()=>{useEmailChecks.setState({records:{'bad@example.org':{screen:{email:'bad@example.org',status:'invalid',reason:'Null MX',checkedAt:123}}}});panel(['good@example.org','bad@example.org']);fireEvent.click(screen.getByRole('button',{name:'验证本页全部（1）'}));await waitFor(()=>expect(h.verify).toHaveBeenCalledTimes(1));expect(h.verify).toHaveBeenCalledWith('good@example.org',false);});
 it('does not call verifier when user cancels',async()=>{h.confirm.mockResolvedValue(false);panel(['cancel@example.org']);fireEvent.click(screen.getByRole('button',{name:'验证本页全部（1）'}));await waitFor(()=>expect(h.confirm).toHaveBeenCalled());expect(h.verify).not.toHaveBeenCalled();});
 it('stops the batch after quota failure',async()=>{h.verify.mockRejectedValueOnce(new Error('额度已用完'));await useEmailChecks.getState().verify(['quota@example.org','next@example.org'],false);expect(h.verify).toHaveBeenCalledTimes(1);expect(useEmailChecks.getState().error).toContain('停止后续');});
 it('records actual unsubscribe feedback and prevents subsequent verification selection',async()=>{h.feedback.mockResolvedValue({kind:'unsubscribe',recordedAt:123});panel(['optout@example.org']);fireEvent.change(screen.getByLabelText('记录联系结果 optout@example.org'),{target:{value:'unsubscribe'}});await waitFor(()=>expect(h.feedback).toHaveBeenCalledWith('optout@example.org','unsubscribe'));await waitFor(()=>expect((screen.getByRole('checkbox',{name:'选择验证 optout@example.org'}) as HTMLInputElement).disabled).toBe(true));expect(h.verify).not.toHaveBeenCalled();});
 it('a passing DNS screen still displays unverified delivery',async()=>{useEmailChecks.setState({records:{'route@example.org':{screen:{email:'route@example.org',status:'passed',checkedAt:123,reason:'MX存在'}}}});await act(async()=>{panel(['route@example.org']);});expect(screen.getByText('未验证投递')).toBeTruthy();expect(screen.queryByText('验证服务通过')).toBeNull();});
 it('shows provider date separately from query time',async()=>{useEmailChecks.setState({records:{'dated@example.org':{verification:{email:'dated@example.org',deliveryStatus:'accept_all',verificationProvider:'Hunter',checkedAt:123,providerDate:'2026-09-01',reason:'全收域'}}}});await act(async()=>{panel(['dated@example.org']);});expect(screen.getByText('全收域·未确认')).toBeTruthy();expect(screen.getByText(/服务记录日期：2026-09-01/)).toBeTruthy();});
 it('refreshes automatic feedback from a native local event without another DNS or paid verification',async()=>{
  panel(['automatic@example.org']);await waitFor(()=>expect(h.pre).toHaveBeenCalled());const before=h.pre.mock.calls.length;
  h.load.mockResolvedValue({'automatic@example.org':{feedback:{kind:'unsubscribe',recordedAt:456,source:'automatic',sourceMessageId:'reply-id',accountId:'a',reason:'明确退订请求'}}});
  await act(async()=>{h.listener?.();});await screen.findByText(/自动识别/);
  expect(screen.getByRole('button',{name:'查看依据邮件'})).toBeTruthy();
  useMailStore.setState({activeAccountId:'other-account',selectedMessageId:'old-message'});
  useUIStore.setState({messageDetailId:'old-message'});
  fireEvent.click(screen.getByRole('button',{name:'查看依据邮件'}));
  expect(useMailStore.getState().activeAccountId).toBe('a');
  expect(useMailStore.getState().selectedMessageId).toBe('reply-id');
  expect(useUIStore.getState().messageDetailId).toBe('reply-id');
  expect(useUIStore.getState().activeView).toBe('messageDetail');
  expect((screen.getByRole('checkbox',{name:'选择验证 automatic@example.org'}) as HTMLInputElement).disabled).toBe(true);
  expect(h.pre).toHaveBeenCalledTimes(before);expect(h.verify).not.toHaveBeenCalled();
 });
});
