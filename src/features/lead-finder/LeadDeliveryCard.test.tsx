import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import LeadDeliveryCard from './LeadDeliveryCard';
import type { BuyingSignal, ContactPerson, EmailResearchEvidence, ResearchContact } from '@/lib/researchEvidence';
afterEach(cleanup);
it('shows business delivery and complete email judgements, not discovery traces or scoring recipes',()=>{
  const open=vi.fn();render(<LeadDeliveryCard openUrl={open} item={{companyIntroduction:'A product distributor.',recommendationReason:'Relevant sales channel; demand unconfirmed.',quality:{level:'needs_review',score:39,productMatch:false,buyerMatch:true,channelMatch:true,checkedPages:3,evidence:[{url:'https://example.invalid/about',quote:'Public business description',kind:'company_identity'}],unknowns:['用户条件待核实：企业规模','主营与渠道依据来自已读网页']},emails:['contact@example.invalid'],emailEvidence:[{email:'contact@example.invalid',source:'官网',sourceUrl:'https://example.invalid/contact',verification:'公开发现，未验证可投递性',emailType:'商务邮箱',suitability:'建议先核实采购岗位'}]}}/>);
  expect(screen.getByText('A product distributor.')).toBeTruthy();expect(screen.getByText('contact@example.invalid')).toBeTruthy();
  const emailRow=screen.getByText('contact@example.invalid').closest('details')!;expect(emailRow.open).toBe(false);fireEvent.click(emailRow.querySelector('summary')!);expect(emailRow.open).toBe(true);
  expect(within(emailRow.querySelector('summary')!).getByText('依据待核实')).toBeTruthy();expect(within(emailRow.querySelector('summary')!).getByText('未验证投递')).toBeTruthy();expect(screen.getByText('企业规模').closest('details')?.open).toBe(false);
  expect(screen.queryByText(/已读 3|证据匹配分|主营与渠道依据/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'邮箱来源1'}));expect(open).toHaveBeenCalledWith('https://example.invalid/contact');
});
it('groups a whole company, contacts and actions in one card and folds duplicate unknown conditions',()=>{
  const save=vi.fn();render(<LeadDeliveryCard openUrl={()=>{}} actions={<button onClick={save}>保存这家公司</button>} item={{companyName:'Sample Trading',website:'https://sample.invalid',companyIntroduction:'Company facts',recommendationReason:'Business relevance, not confirmed intent',emails:['sales@sample.invalid'],quality:{level:'needs_review',score:39,productMatch:false,buyerMatch:true,channelMatch:true,checkedPages:2,evidence:[],unknowns:['用户条件待核实：排除线上电商平台','用户条件待核实：排除线上电商平台','用户条件待核实：公司规模']}}}/>);
  const card=screen.getByRole('article',{name:'Sample Trading的搜客结果'});
  expect(card.contains(screen.getByRole('heading',{name:'Sample Trading'}))).toBe(true);
  expect(card.contains(screen.getByText('sales@sample.invalid'))).toBe(true);
  expect(card.contains(screen.getByRole('button',{name:'保存这家公司'}))).toBe(true);
  const details=screen.getByText(/待核实 2 项/).closest('details')!;expect(details.open).toBe(false);
  expect(screen.getAllByText('排除线上电商平台')).toHaveLength(1);expect(screen.getByText('部分要求待确认')).toBeTruthy();
  details.open=true;expect(details.querySelectorAll('li')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'保存这家公司'}));expect(save).toHaveBeenCalledTimes(1);
});
it('does not offer a duplicate retry while the actual contact job is running',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} retryContact={vi.fn()} item={{emailDiscoveryStatus:'running'}}/>);
  expect(screen.getByText('正在查找公开邮箱…')).toBeTruthy();expect(screen.queryByRole('button',{name:'重新查找邮箱'})).toBeNull();
});
it('keeps all discovered emails and never invents a deliverability judgement',()=>{
  const emails=Array.from({length:8},(_,i)=>`sales${i}@example.invalid`);
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails}}/>);
  for(const email of emails){const row=screen.getByText(email).closest('details')!;expect(row.open).toBe(false);expect(row.querySelector('summary')?.textContent).toContain('未验证投递');}
  expect(document.querySelectorAll('.lead-delivery__email')).toHaveLength(8);
});
it('keeps explicit unsuitable-mail warnings visible even when the full judgement is collapsed',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:['privacy@example.invalid'],emailEvidence:[{email:'privacy@example.invalid',source:'官网',sourceUrl:'https://example.invalid/contact',verification:'公开发现',suitability:'不建议：隐私事务，不是采购岗位'}]}}/>);
  const summary=screen.getByText('privacy@example.invalid').closest('details')!.querySelector('summary')!;
  expect(within(summary).getByText('不建议：隐私事务，不是采购岗位')).toBeTruthy();
});

const emailEvidence: EmailResearchEvidence = { email:'contact@example.invalid',source:'网页',sourceUrl:'https://example.invalid/contact',verification:'' };
const summaryFor=(email:string)=>screen.getByText(email).closest('details')!.querySelector('summary')!;

it.each([
  ['published','not_checked','官网/页面公开','未验证投递'],
  ['provider_reported','valid','第三方报告','验证服务通过'],
  ['published','accept_all','官网/页面公开','全收域·未确认'],
  ['published','invalid','官网/页面公开','无效'],
  ['unknown','unknown','依据待核实','未知'],
  ['provider_reported','blocked','第三方报告','受阻'],
  ['published','disposable','官网/页面公开','一次性'],
] as const)('renders independent %s/%s dimensions in the collapsed row',(evidenceKind,deliveryStatus,evidenceLabel,deliveryLabel)=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:[emailEvidence.email],emailEvidence:[{...emailEvidence,evidenceKind,deliveryStatus}]}}/>);
  const summary=within(summaryFor(emailEvidence.email));
  expect(summary.getByText(evidenceLabel)).toBeTruthy();expect(summary.getByText(deliveryLabel)).toBeTruthy();
  expect(summaryFor(emailEvidence.email).closest('details')!.open).toBe(false);
});

it.each(['pattern','guessed'] as const)('makes %s warning visible and replaces ordinary sending advice',(evidenceKind)=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:[emailEvidence.email],emailEvidence:[{...emailEvidence,evidenceKind,deliveryStatus:'valid',suitability:'建议立即发送开发信'}]}}/>);
  const summary=within(summaryFor(emailEvidence.email));
  expect(summary.getByText(/需确认：推导或猜测邮箱/)).toBeTruthy();expect(summary.queryByText('官网/页面公开')).toBeNull();
  expect(summary.getByText('验证服务通过')).toBeTruthy();expect(screen.queryByText('建议立即发送开发信')).toBeNull();
  expect(screen.getAllByText(/不建议直接发送/).length).toBeGreaterThan(0);
});

it('keeps mixed legacy results conservative without displaying the raw verification process',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:[emailEvidence.email],emailEvidence:[{...emailEvidence,verification:'Hunter 可投递/全收域；内部推理工具步骤',suitability:'建议立即发送开发信'}]}}/>);
  const summary=within(summaryFor(emailEvidence.email));
  expect(summary.getAllByText('历史结果混合·需复核').length).toBeGreaterThan(0);
  expect(summary.getByText('依据待核实')).toBeTruthy();
  expect(screen.queryByText(/内部推理工具步骤/)).toBeNull();expect(screen.queryByText('建议立即发送开发信')).toBeNull();
});

it('uses later structured evidence and shows the corresponding verifier and time',()=>{
  const time=Date.UTC(2026,9,20,8);
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:[emailEvidence.email],emailEvidence:[
    {...emailEvidence,verification:'Hunter 可投递/全收域'},
    {...emailEvidence,evidenceKind:'published',deliveryStatus:'valid',verifiedAt:time,verificationProvider:'Example verifier'},
  ]}}/>);
  const summary=within(summaryFor(emailEvidence.email));
  expect(summary.getByText('官网/页面公开')).toBeTruthy();expect(summary.getByText('验证服务通过')).toBeTruthy();
  expect(screen.queryByText('历史结果混合·需复核')).toBeNull();
  expect(screen.getByText(`验证服务：Example verifier · 验证时间：${new Date(time).toLocaleString('zh-CN')}`)).toBeTruthy();
});

const contact: ResearchContact={name:'Example Person',role:'Operations lead',sourceUrl:'https://example.invalid/team',quote:'Example Person — Operations lead',roleVerified:true};

it('shows a named person without a mailbox in a compact company card and opens name, role and source proof',()=>{
  const open=vi.fn();render(<LeadDeliveryCard openUrl={open} item={{companyName:'Example Company',contacts:[contact]}}/>);
  const card=screen.getByRole('article',{name:'Example Company的搜客结果'});
  const people=within(card).getByRole('region',{name:'人员来源'});
  expect(within(people).getByText('姓名/职位有来源引用，当前任职未确认')).toBeTruthy();
  expect(within(people).getAllByText(/实际采购权未知/).length).toBeGreaterThan(0);
  expect(within(people).getByText(contact.quote)).toBeTruthy();
  expect(people.querySelector('details')!.open).toBe(false);
  fireEvent.click(within(people).getByRole('button',{name:'Example Person · Operations lead'}));
  fireEvent.click(within(people).getByRole('button',{name:contact.sourceUrl}));
  expect(open.mock.calls).toEqual([[contact.sourceUrl],[contact.sourceUrl]]);
  expect(document.querySelectorAll('.lead-delivery__email')).toHaveLength(0);
});

it('shows structured person proof separately and does not promote legacy person text or email provenance',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:[emailEvidence.email],emailEvidence:[{
    ...emailEvidence,evidenceKind:'published',personName:'Example Person',personRole:'Operations lead',roleVerified:true,
  }]}}/>);
  const people=screen.getByRole('region',{name:'人员来源'});
  expect(within(people).getByText('姓名/职位待核实')).toBeTruthy();
  expect(within(people).getByText('姓名与职位来源待补充')).toBeTruthy();
  expect(within(people).queryByRole('button')).toBeNull();
  expect(within(people).queryByText('姓名/职位有来源引用，当前任职未确认')).toBeNull();
});

it('keeps unverified roles visibly unconfirmed even with a source and quote',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{contacts:[{...contact,roleVerified:false}]}}/>);
  expect(screen.getByText('姓名/职位有来源引用，当前任职未确认')).toBeTruthy();
  expect(screen.getByText('现职未确认 · 实际采购权未知')).toBeTruthy();
});

it('never adds evidence-only mailboxes to the supplied email list',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{emails:['allowed@example.invalid'],emailEvidence:[{...emailEvidence,evidenceKind:'published',deliveryStatus:'valid'}]}}/>);
  expect(screen.getByText('allowed@example.invalid')).toBeTruthy();expect(screen.queryByText(emailEvidence.email)).toBeNull();
  expect(document.querySelectorAll('.lead-delivery__email')).toHaveLength(1);
});

it('folds historical people separately and never counts them as current contacts',()=>{
  const historical: ContactPerson={...contact,name:'Historical Example',role:'Former founder',roleVerified:false,sourceDate:'2001',observedAt:1_792_512_000,currentStatus:'historical'};
  render(<LeadDeliveryCard openUrl={()=>{}} item={{contacts:[historical,{...contact,roleVerified:false,currentStatus:'unconfirmed'}]}}/>);
  const people=screen.getByRole('region',{name:'人员来源'});
  expect(within(people).getByText('具名人员（1）；现职与实际采购权均未确认。')).toBeTruthy();
  const history=within(people).getByText('历史人物（1）· 不作现任联系人').closest('details')!;
  expect(history.open).toBe(false);
  expect(history.contains(screen.getByText('Historical Example · Former founder'))).toBe(true);
  expect(history.contains(screen.getByText('Example Person · Operations lead'))).toBe(false);
  fireEvent.click(history.querySelector('summary')!);
  expect(within(people).getByRole('button',{name:'Historical Example · Former founder'})).toBeTruthy();
  expect(within(history).getByText(/来源日期：2001 · 观察时间：/)).toBeTruthy();
  expect(within(history).getByText('仅作历史资料；实际采购权未知。')).toBeTruthy();
});

it('does not show a current-contact count for a historical-only result',()=>{
  render(<LeadDeliveryCard openUrl={()=>{}} item={{contacts:[{...contact,currentStatus:'historical',roleVerified:false}]}}/>);
  expect(screen.queryByText(/具名人员（/)).toBeNull();
  expect(screen.getByText('历史人物（1）· 不作现任联系人').closest('details')!.open).toBe(false);
});

it('keeps observed business signals compact with clickable proof and no claim of purchase intent',()=>{
  const open=vi.fn();
  const signal: BuyingSignal={kind:'trade_activity',summary:'Example company exhibited at an industry event.',sourceUrl:'https://example.invalid/events',quote:'Example company exhibited at an industry event.',observedAt:1_792_512_000};
  render(<LeadDeliveryCard openUrl={open} item={{buyingSignals:[signal]}}/>);
  const signals=screen.getByRole('region',{name:'业务证据'});
  expect(within(signals).getByText('公开业务线索，不代表采购意向。')).toBeTruthy();
  const details=signals.querySelector('details')!;expect(details.open).toBe(false);
  expect(within(details.querySelector('summary')!).getByText(signal.summary)).toBeTruthy();
  expect(screen.queryByText('trade_activity')).toBeNull();
  fireEvent.click(details.querySelector('summary')!);
  fireEvent.click(within(signals).getByRole('button',{name:signal.sourceUrl}));
  expect(open).toHaveBeenCalledWith(signal.sourceUrl);
  expect(within(signals).getByText(/观察时间：/)).toBeTruthy();
});
