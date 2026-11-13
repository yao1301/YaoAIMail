import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import CompanyResearchView from './CompanyResearchView';
import type {CompanyResearchReport} from '@/lib/api';
import {useBackgroundTasksStore} from '@/stores/backgroundTasks.store';
const h=vi.hoisted(()=>({list:vi.fn(),research:vi.fn(),invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:h.invoke}));
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),listCompanyResearch:h.list,researchCompany:h.research}));
vi.mock('@/components/ExternalApiKeyPanel',()=>({default:()=>null}));
afterEach(cleanup);
beforeEach(()=>{useBackgroundTasksStore.setState({tasks:{}});h.research.mockReset();h.list.mockReset();h.invoke.mockReset().mockResolvedValue(undefined);});
const report:CompanyResearchReport={id:'anonymous',companyName:'Acme Flowers',website:'https://acme.invalid/',country:'Germany',websiteTitle:'Acme',websiteDescription:'Wholesale botanical products.',publicEmails:['contact@acme.invalid'],legalMatches:[],sources:[],warnings:[],analysis:'',createdAt:1,structureVersion:3,pagesRead:4,dossier:{profile:[],findings:[],risks:[],gaps:[],summary:'',riskLevel:'unknown',dropped:0},registries:[],registryLinks:[]};
it('keeps historical people distinct and treats business signals as evidence rather than purchasing intent',async()=>{
 h.list.mockResolvedValue([{...report,structureVersion:6,contacts:[{name:'Taylor Sample',role:'Founder',sourceUrl:'https://acme.invalid/history',quote:'Taylor Sample founded the business in 1930.',roleVerified:false,currentStatus:'historical'}],buyingSignals:[{kind:'business_role',summary:'We distribute components.',sourceUrl:'https://acme.invalid/about',quote:'We distribute components.',observedAt:100}]}]);
 render(<CompanyResearchView/>);
 expect(await screen.findByText('Taylor Sample')).toBeTruthy();
 expect(screen.getByText(/历史人物，非现任联系依据/)).toBeTruthy();
 expect(screen.getByText(/经营与贸易信号（不代表当前采购意向或信用评级）/)).toBeTruthy();
 expect(h.research).not.toHaveBeenCalled();
});
it('keeps official website description and public email visible when the model dossier is empty',async()=>{
 h.list.mockResolvedValue([report]);render(<CompanyResearchView/>);
 expect(await screen.findByText('contact@acme.invalid')).toBeTruthy();expect(screen.getByText('Wholesale botanical products.')).toBeTruthy();expect(screen.getByRole('button',{name:'打开官网来源'})).toBeTruthy();
 expect(screen.getByText(/未验证可投递性或采购岗位/)).toBeTruthy();expect(h.research).not.toHaveBeenCalled();
});
it('does not present name-only registry candidates or transport failures as verified identities',async()=>{
 h.list.mockResolvedValue([{...report,registries:[{name:'GLEIF',status:'candidate',summary:'名称候选，主体未确认',url:'',items:[]},{name:'SEC',status:'error',summary:'查询未完成',url:'',items:[]}]}]);render(<CompanyResearchView/>);
 expect(await screen.findByText('主体待确认')).toBeTruthy();expect(screen.getByText('查询失败')).toBeTruthy();expect(screen.queryByText('已核验')).toBeNull();
});
it('labels third-party business facts as disclosures rather than independently verified facts',async()=>{
 h.list.mockResolvedValue([{...report,dossier:{...report.dossier!,profile:[{key:'employees',label:'员工规模',value:'约1-10名员工',url:'https://directory.invalid/acme',quote:'Directory reports approximately 1-10 employees.',level:'reported'}]}}]);render(<CompanyResearchView/>);
 expect(await screen.findByText('约1-10名员工')).toBeTruthy();expect(screen.getByText('第三方披露，待交叉核验')).toBeTruthy();
});
it('shows the complete narrative first and keeps technical details collapsed for restored reports',async()=>{
 const analysis='## 经营与履约能力\n有具体依据的团队、产品、渠道和交易分析。\n'.repeat(60);
 h.list.mockResolvedValue([{...report,structureVersion:4,analysis,warnings:['某来源查询未完成'],registries:[{name:'GLEIF',status:'no_match',summary:'没有名称一致记录',url:'',items:[]}]}]);render(<CompanyResearchView/>);
 const section=await screen.findByRole('region',{name:'完整调查报告'});
 expect(section.textContent!.length).toBeGreaterThan(900);expect(section.textContent).toContain('经营与履约能力');
 expect(screen.getByText('某来源查询未完成').closest('details')!.open).toBe(false);
 expect(screen.queryByText('证据不足')).toBeNull();expect(h.research).not.toHaveBeenCalled();
});
it('keeps historical full reports readable without an upgrade nag or an automatic rerun',async()=>{
 h.list.mockResolvedValue([{...report,structureVersion:0,analysis:'## 主体及经营分析\n历史完整报告保留。'}]);render(<CompanyResearchView/>);
 expect(await screen.findByText('历史完整报告保留。')).toBeTruthy();expect(screen.queryByText(/重新调查可以得到结构化档案/)).toBeNull();expect(h.research).not.toHaveBeenCalled();
});
it('opens narrative citations through the desktop external-link command',async()=>{
 h.list.mockResolvedValue([{...report,structureVersion:4,analysis:'完整分析。[来源1](https://acme.invalid/about)'}]);render(<CompanyResearchView/>);
 fireEvent.click(await screen.findByRole('link',{name:'来源1'}));
 expect(h.invoke).toHaveBeenCalledWith('open_external_url',{url:'https://acme.invalid/about'});
});
it('shows external source coverage without turning missing documents or SDN screening into a clearance',async()=>{
 h.list.mockResolvedValue([{...report,structureVersion:5,analysis:'调查正文。',investigation:{officialPages:3,externalPages:7,externalSites:5,duplicatePages:1,followUpQueries:4,areas:[{key:'risk',label:'风险线索',status:'searched_no_readable_evidence',documents:0},{key:'sanctions',label:'制裁名单名称初筛',status:'screened',documents:0}]},registries:[{name:'OFAC SDN',status:'screened',summary:'只做精确名称初筛',url:'',items:[]}]}]);render(<CompanyResearchView/>);
 expect(await screen.findByRole('region',{name:'调查资料覆盖'})).toBeTruthy();expect(screen.getByText(/外部正文 7 页/)).toBeTruthy();
 expect(screen.getByText(/已检索，未取得可读原文/)).toBeTruthy();expect(screen.getByText('名称初筛完成，非合规放行')).toBeTruthy();expect(screen.queryByText('已核验')).toBeNull();
});
it('compares dated snapshots without new searches or treating new source links as company events',async()=>{
 h.list.mockResolvedValue([{...report,id:'new',createdAt:200,structureVersion:5,sources:[{title:'External record',url:'https://registry.invalid/record',status:'checked'}]},report]);render(<CompanyResearchView/>);
 expect(await screen.findByLabelText('与历史调查对比')).toBeTruthy();expect(screen.getByText(/本次新增已读资料入口 1 个/)).toBeTruthy();expect(screen.getByText(/不将新找到的旧资料当作公司新发生的事件/)).toBeTruthy();expect(h.research).not.toHaveBeenCalled();
});
it('retains the latest native stage after leaving and returning to a running research task',async()=>{
 useBackgroundTasksStore.setState({tasks:{companyResearch:{id:'companyResearch',label:'客户资信调查',status:'running',startedAt:1,progress:'正在追查人物和登记线索'}}});h.list.mockResolvedValue([]);render(<CompanyResearchView/>);
 expect(await screen.findByRole('button',{name:'正在追查人物和登记线索…'})).toBeTruthy();expect(h.research).not.toHaveBeenCalled();
});
it('does not turn default zero coverage on an old native report into measured statistics',async()=>{
 h.list.mockResolvedValue([{...report,structureVersion:4,analysis:'旧报告正文。',investigation:{officialPages:0,externalPages:0,externalSites:0,duplicatePages:0,followUpQueries:0,areas:[]}}]);render(<CompanyResearchView/>);
 expect(await screen.findByText('旧报告正文。')).toBeTruthy();expect(screen.queryByRole('region',{name:'调查资料覆盖'})).toBeNull();
});
