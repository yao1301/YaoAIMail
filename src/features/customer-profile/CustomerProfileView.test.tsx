import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import CustomerProfileView from './CustomerProfileView';
import type {CustomerMemory} from '@/lib/api';
import {useBackgroundTasksStore} from '@/stores/backgroundTasks.store';
import {useMailStore} from '@/stores/mail.store';
import {useUIStore} from '@/stores/ui.store';
const h=vi.hoisted(()=>({list:vi.fn(),save:vi.fn(),refresh:vi.fn(),contacts:vi.fn(),accounts:vi.fn(),search:vi.fn(),researches:vi.fn(),oldBuild:vi.fn(),agent:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn().mockResolvedValue(undefined)}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),listCustomerMemories:h.list,saveCustomerMemory:h.save,refreshCustomerProfile:h.refresh,listAddressBookContacts:h.contacts,listAccounts:h.accounts,listCompanyResearch:h.researches,getCustomerProfileMail:h.search,buildCustomerMemory:h.oldBuild,agentRun:h.agent}));
const memory=(id='a',name='Alice'):CustomerMemory=>({id,email:`${id}@sample.invalid`,name,company:'Sample Company',summary:'Original summary',profile:'Original profile',messageCount:12,contacts:[],source:'展会',status:'',stage:'已报价',tags:['定制需求'],tier:'A',nextFollowUp:1,followUps:[],accountIds:['account-a'],followUpSequence:[],followUpSequencePaused:false,updatedAt:100});
function deferred<T>(){let resolve!:(v:T)=>void;let reject!:(v:Error)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
beforeEach(()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
 useBackgroundTasksStore.setState({tasks:{}});useMailStore.setState({activeAccountId:'account-a',selectedMessageId:'unrelated-thread'});
 useUIStore.setState({customerProfileEmail:null,customerProfileSearch:'',customerProfileFilter:''});
 for(const fn of Object.values(h))fn.mockReset();
 h.list.mockResolvedValue([]);h.contacts.mockResolvedValue([]);h.accounts.mockResolvedValue([{id:'account-a',email:'owner@sample.invalid',display_name:'Work'}]);h.search.mockResolvedValue([]);h.researches.mockResolvedValue([]);
 h.save.mockImplementation(async input=>({...memory(input.id||'new',''),...input,id:input.id||'new'}));h.refresh.mockResolvedValue({...memory('new',''),profile:'Generated profile',messageCount:4});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('has one generate action, automatically scopes mail, refreshes online and saves without old agent/thread calls',async()=>{
 render(<CustomerProfileView/>);await waitFor(()=>expect(h.accounts).toHaveBeenCalled());
 fireEvent.change(screen.getByPlaceholderText('输入邮箱，或从地址本下拉选择'),{target:{value:'new@sample.invalid'}});
 fireEvent.click(screen.getByRole('button',{name:'生成客户画像'}));
 await waitFor(()=>expect(h.refresh).toHaveBeenCalledWith('new'));
 await screen.findByDisplayValue('Generated profile');
 expect(h.save.mock.calls[0][0].accountIds).toEqual(['account-a']);
 expect(screen.getAllByRole('button',{name:'更新客户画像'})).toHaveLength(1);
 expect(h.oldBuild).not.toHaveBeenCalled();expect(h.agent).not.toHaveBeenCalled();
 expect(screen.getByText(/分析 4 封邮件正文片段/)).toBeTruthy();
});
it('keeps CRM status, traits, follow-up plan and research visible while preserving metadata',async()=>{
 const m=memory();h.list.mockResolvedValue([m]);h.refresh.mockResolvedValue({...m,profile:'Refreshed profile',messageCount:8});render(<CustomerProfileView/>);
 fireEvent.click(await screen.findByRole('button',{name:/Alice/}));
 const overview=screen.getByRole('region',{name:'客户状态总览'});
 expect(within(overview).getByText('定制需求',{selector:'span'})).toBeTruthy();
 expect(within(overview).getByRole('button',{name:/已报价/}).getAttribute('aria-pressed')).toBe('true');
 for(const name of ['跟进计划','往来与跟进','资信调查'])expect(screen.getByRole('region',{name}).closest('details')).toBeNull();
 expect(screen.queryByRole('button',{name:'更新画像'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'更新客户画像'}));await screen.findByDisplayValue('Refreshed profile');
 expect(h.save.mock.calls[0][0]).toMatchObject({id:'a',stage:'已报价',tier:'A',tags:['定制需求']});expect(h.refresh).toHaveBeenCalledWith('a');
});
it('does not apply customer A result over customer B when navigating during refresh',async()=>{
 const pending=deferred<CustomerMemory>();const a=memory(),b=memory('b','Blair');h.list.mockResolvedValue([a,b]);h.refresh.mockReturnValue(pending.promise);
 render(<CustomerProfileView/>);fireEvent.click(await screen.findByRole('button',{name:/Alice/}));fireEvent.click(screen.getByRole('button',{name:'更新客户画像'}));
 await waitFor(()=>expect(h.refresh).toHaveBeenCalled());fireEvent.click(screen.getByRole('button',{name:/Blair/}));
 await act(async()=>pending.resolve({...a,profile:'A new profile'}));
 expect(screen.getByDisplayValue('b@sample.invalid')).toBeTruthy();expect(screen.queryByDisplayValue('A new profile')).toBeNull();
});
it('does not overwrite unsaved text typed while the native task is running',async()=>{
 const pending=deferred<CustomerMemory>();const a=memory();h.list.mockResolvedValue([a]);h.refresh.mockReturnValue(pending.promise);render(<CustomerProfileView/>);
 fireEvent.click(await screen.findByRole('button',{name:/Alice/}));fireEvent.click(screen.getByRole('button',{name:'更新客户画像'}));await waitFor(()=>expect(h.refresh).toHaveBeenCalled());
 fireEvent.change(screen.getByDisplayValue('Original profile'),{target:{value:'My unsaved correction'}});
 await act(async()=>pending.resolve({...a,profile:'Generated replacement'}));expect(screen.getByDisplayValue('My unsaved correction')).toBeTruthy();
});
it('preserves the old profile and displays a dismissible real failure instead of an empty success',async()=>{
 h.list.mockResolvedValue([memory()]);h.refresh.mockRejectedValue(new Error('有效邮件结构未返回，旧画像已保留'));render(<CustomerProfileView/>);
 fireEvent.click(await screen.findByRole('button',{name:/Alice/}));fireEvent.click(screen.getByRole('button',{name:'更新客户画像'}));
 expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByDisplayValue('Original profile')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'关闭错误提示'}));expect(screen.queryByRole('alert')).toBeNull();
});
it('waits for hydration before consuming an address-book jump to an existing customer',async()=>{
 const pending=deferred<CustomerMemory[]>();h.list.mockReturnValue(pending.promise);useUIStore.setState({customerProfileEmail:'a@sample.invalid'});render(<CustomerProfileView/>);
 await act(async()=>pending.resolve([memory()]));expect(await screen.findByDisplayValue('Original profile')).toBeTruthy();expect(screen.getByRole('button',{name:'更新客户画像'})).toBeTruthy();
});
it('requires an explicit mail scope when there are multiple accounts and none is active',async()=>{
 useMailStore.setState({activeAccountId:null});h.accounts.mockResolvedValue([{id:'a',email:'a@sample.invalid'},{id:'b',email:'b@sample.invalid'}]);render(<CustomerProfileView/>);
 await waitFor(()=>expect(screen.getByText('未关联账号，无法保存')).toBeTruthy());fireEvent.change(screen.getByPlaceholderText('输入邮箱，或从地址本下拉选择'),{target:{value:'buyer@sample.invalid'}});fireEvent.click(screen.getByRole('button',{name:'生成客户画像'}));
 await act(async()=>{});expect(h.refresh).not.toHaveBeenCalled();expect(h.save).not.toHaveBeenCalled();
});
it('shows the actual research summary without associating unrelated or empty-name reports',async()=>{
 h.list.mockResolvedValue([memory()]);h.researches.mockResolvedValue([
  {id:'good',companyName:'Sample Company',website:'https://sample.invalid/',createdAt:10,analysis:'该公司的公开业务资料。',publicEmails:[]},
  {id:'other',companyName:'',website:'https://unrelated.invalid/',createdAt:20,analysis:'不应串入其他客户的调查',publicEmails:[]},
 ]);render(<CustomerProfileView/>);fireEvent.click(await screen.findByRole('button',{name:/Alice/}));await act(async()=>{});
 const summary=screen.getByRole('region',{name:'资信调查'}).querySelector('.crm-research__snapshot')!;
 expect(summary.textContent).toContain('该公司的公开业务资料');expect(summary.closest('details')).toBeNull();expect(screen.queryByText('不应串入其他客户的调查')).toBeNull();
});
it('opens a real timeline email in its own account, not the previously active account',async()=>{
 h.list.mockResolvedValue([memory()]);h.search.mockResolvedValue([{message_id:'mail-1',account_id:'account-b',score:1,date:100,snippet:'Sample request',subject:'Delivery question',from_address:'a@sample.invalid'}]);
 render(<CustomerProfileView/>);fireEvent.click(await screen.findByRole('button',{name:/Alice/}));
 const link=await within(screen.getByRole('region',{name:'往来与跟进'})).findByRole('button',{name:/Delivery question/});fireEvent.click(link);
 expect(useMailStore.getState().activeAccountId).toBe('account-b');expect(useUIStore.getState().messageDetailId).toBe('mail-1');expect(useUIStore.getState().activeView).toBe('messageDetail');
});
