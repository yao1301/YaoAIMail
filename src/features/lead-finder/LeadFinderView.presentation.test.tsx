import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LeadFinderView from './LeadFinderView';
import { useBackgroundTasksStore } from '@/stores/backgroundTasks.store';
import { useLeadTaskProgress } from './leadTaskProgress';
import { useUIStore } from '@/stores/ui.store';

const h=vi.hoisted(()=>({load:vi.fn(),save:vi.fn(),prompt:vi.fn(),discover:vi.fn(),enrich:vi.fn()}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),loadLeadFinderData:h.load,saveLeadFinderData:h.save,leadResearchPrompt:h.prompt,discoverLeads:h.discover,enrichLeadCandidate:h.enrich}));
vi.mock('@/hooks/queries',()=>({useAccountsQuery:()=>({data:[]})}));
vi.mock('@/components/KnowledgePicker',()=>({default:()=>null}));
vi.mock('./useLeadDevRecords',()=>({useLeadDevRecords:()=>({records:[],append:vi.fn(),remove:vi.fn()})}));
const task=(i:number)=>({id:`task-${i}`,title:`历史任务 ${i}`,summary:'Saved intent',product:'gift lights',market:'USA',buyerType:'',query:'Find gift buyers',page:1,resultCount:1,createdAt:1,updatedAt:1720000000000+i,results:[{companyName:`Company ${i}`,website:`https://company-${i}.invalid`,description:'Recorded business facts',emailDiscoveryStatus:'completed'}]});
const show=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal');
const close=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
beforeEach(()=>{
  localStorage.clear();useUIStore.setState({leadFinderDraft:null,leadContextQueue:[],leadContextAttachmentQueue:[],knowledgeContextQueue:[]});
  useBackgroundTasksStore.setState({tasks:{}});useLeadTaskProgress.setState({active:null});
  h.load.mockReset().mockResolvedValue({searchSessions:Array.from({length:30},(_,i)=>task(i)),savedLeads:[]});h.save.mockReset().mockResolvedValue(undefined);h.prompt.mockReset();h.discover.mockReset();h.enrich.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.open=true;}});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.open=false;}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();
  if(show)Object.defineProperty(HTMLDialogElement.prototype,'showModal',show);else delete (HTMLDialogElement.prototype as any).showModal;
  if(close)Object.defineProperty(HTMLDialogElement.prototype,'close',close);else delete (HTMLDialogElement.prototype as any).close;
});
it('places search presets after the composer instead of the redundant batch toggle',async()=>{
 render(<LeadFinderView/>);await screen.findByRole('button',{name:'历史任务（30）'});
 const presets=screen.getByText('保存搜索条件');
 const search=screen.getByRole('button',{name:'开始搜索'});
 expect(search.compareDocumentPosition(presets)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.queryByLabelText('批量搜客')).toBeNull();expect(screen.queryByLabelText('批量搜索')).toBeNull();
 expect(screen.queryByText('客户画像 · 保存并复用搜索条件')).toBeNull();expect(h.discover).not.toHaveBeenCalled();
});
it('waits for history hydration before consuming a completed background delivery',async()=>{
  let hydrate!:(data:any)=>void;
  h.load.mockImplementation(()=>new Promise(resolve=>{hydrate=resolve;}));
  const existing=task(1);existing.results=[] as any;existing.resultCount=0;existing.page=0;
  const delivered={...task(2).results[0],companyName:'Recovered delivery',emailDiscoveryStatus:'completed'};
  useBackgroundTasksStore.setState({tasks:{leadFinder:{id:'leadFinder',label:'Search',status:'success',startedAt:1,
    result:{sessionId:existing.id,page:1,items:[delivered]}}}});
  render(<LeadFinderView/>);await act(async()=>{});
  expect(useBackgroundTasksStore.getState().tasks.leadFinder?.status).toBe('success');
  await act(async()=>{hydrate({searchSessions:[existing],savedLeads:[]});});
  await waitFor(()=>expect(h.save.mock.calls.some(([data])=>data.searchSessions?.[0]?.resultCount===1)).toBe(true));
  expect(useBackgroundTasksStore.getState().tasks.leadFinder).toBeUndefined();
  expect(h.prompt).not.toHaveBeenCalled();expect(h.discover).not.toHaveBeenCalled();
});
it('selects one of thirty history tasks straight into a single company card without any search or model calls',async()=>{
  render(<LeadFinderView/>);await screen.findByRole('button',{name:'历史任务（30）'});
  expect(screen.queryByRole('button',{name:/历史任务 29 USA/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'历史任务（30）'}));
  fireEvent.click(screen.getByRole('button',{name:/历史任务 29 USA/}));
  const results=screen.getByRole('region',{name:'当前客户结果'});
  expect(within(results).getByRole('article',{name:'Company 29的搜客结果'})).toBeTruthy();
  expect(within(results).queryByText('Company 28')).toBeNull();expect(screen.queryByRole('dialog')).toBeNull();
  expect(h.discover).not.toHaveBeenCalled();expect(h.prompt).not.toHaveBeenCalled();expect(h.enrich).not.toHaveBeenCalled();
});
it('uses real async boundaries and native progress to update one status, without extra search calls',async()=>{
  h.load.mockResolvedValue({searchSessions:[],savedLeads:[]});
  let finishBrief!:(text:string)=>void,finishSearch!:(data:any)=>void,progress!:(data:any)=>void;
  h.prompt.mockImplementation(()=>new Promise(resolve=>{finishBrief=resolve;}));
  h.discover.mockImplementation((_request:any,onProgress:any)=>{progress=onProgress;return new Promise(resolve=>{finishSearch=resolve;});});
  render(<LeadFinderView/>);await act(async()=>{});
  fireEvent.change(screen.getByPlaceholderText('产品或服务（支持中文 / English，可选）'),{target:{value:'gift lights'}});
  fireEvent.click(screen.getByRole('button',{name:'开始搜索'}));
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('理解你的指令'));
  await act(async()=>{finishBrief(JSON.stringify({coreCategory:'Gift lights',searchProduct:'gift light',searchChannels:['gift retailers'],useCases:['consumer gifts'],mandatoryQualifiers:[],adjacentBuyerChannels:[],exclusionSignals:[],searchAliases:[],taskTitle:'Gift buyers',taskSummary:'Find gift buyers'}));});
  await waitFor(()=>expect(screen.getByRole('status').textContent).toContain('正在搜索'));
  const report={queries:2,searchHits:3,directoriesRead:0,sitesRead:2,pagesRead:3,unreadSites:0,warnings:[],reviewedCompanies:1};
  await act(async()=>{progress({items:[],report});});expect(screen.getByRole('status').textContent).toContain('核验公司');
  await act(async()=>{finishSearch({items:[],report});});await waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
  expect(h.prompt).toHaveBeenCalledTimes(1);expect(h.discover).toHaveBeenCalledTimes(1);
});

it('fills a partial page by requesting only its missing slots and reuses the interpreted task',async()=>{
  h.load.mockResolvedValue({searchSessions:[],savedLeads:[]});
  h.prompt.mockResolvedValue(JSON.stringify({coreCategory:'Industrial parts',searchProduct:'industrial parts',searchChannels:['industrial distributors'],mandatoryQualifiers:[],exclusionSignals:[],searchAliases:[]}));
  const quality={level:'channel_candidate',score:65,productMatch:true,buyerMatch:true,evidence:[],unknowns:[],checkedPages:1};
  const items=(start:number,count:number)=>Array.from({length:count},(_,n)=>({company:{legalName:`Example company ${start+n}`,website:`https://example-company-${start+n}.invalid`,description:'Industrial components distributor',recommendationReason:'Relevant procurement channel'},quality}));
  const report={queries:4,searchHits:10,directoriesRead:0,sitesRead:4,pagesRead:5,unreadSites:0,warnings:[],stopReason:'time_limit'};
  h.discover.mockResolvedValueOnce({items:items(0,3),report}).mockResolvedValueOnce({items:items(3,17),report:{...report,stopReason:'target_reached',targetReached:true}});
  h.enrich.mockResolvedValue({publicEmails:[],emailEvidence:[]});
  render(<LeadFinderView/>);await act(async()=>{});
  fireEvent.change(screen.getByPlaceholderText('产品或服务（支持中文 / English，可选）'),{target:{value:'industrial parts'}});
  fireEvent.click(screen.getByRole('button',{name:'开始搜索'}));
  await waitFor(()=>expect(screen.getByLabelText('本页交付数量').textContent).toContain('3/20'));
  fireEvent.click(screen.getByRole('button',{name:'继续补充客户'}));
  await waitFor(()=>expect(h.discover).toHaveBeenCalledTimes(2));
  expect(h.discover.mock.calls[0][0].batchMode).toBe(true);
  expect(h.discover.mock.calls[1][0].batchMode).toBe(true);
  expect(h.discover.mock.calls[1][0].pageSize).toBe(17);
  await waitFor(()=>expect(screen.getAllByRole('article')).toHaveLength(20));
  expect(h.prompt).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('本页交付数量').textContent).toBe('本页已找到 20 家');
},20000);
