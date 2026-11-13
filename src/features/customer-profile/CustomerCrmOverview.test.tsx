import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import CustomerCrmOverview,{localDateValue} from './CustomerCrmOverview';
const customer={email:'buyer@sample.invalid',company:'Sample Studio',stage:'已寄样',status:'',source:'展会',tags:['定制需求','自定义特征'],tier:'A',summary:'关注产品规格和交期。',nextFollowUp:new Date(2030,2,5).getTime(),followUps:[{id:'f',date:new Date(2026,5,1).getTime(),channel:'电话',note:'约定下周确认测试结果'}]};
afterEach(cleanup);
it('shows actual stage, all selected traits, follow-up date and most recent interaction immediately',()=>{
 const change=vi.fn(),jump=vi.fn();render(<CustomerCrmOverview customer={customer} mail={[]} onChange={change} onShowActivity={jump}/>);
 expect(screen.getByRole('button',{name:/已寄样/}).getAttribute('aria-pressed')).toBe('true');
 const traits=screen.getByText('自定义特征',{selector:'span'});expect(traits.closest('details')).toBeNull();
 expect((screen.getByLabelText('下次跟进日期') as HTMLInputElement).value).toBe('2030-03-05');
 fireEvent.click(screen.getByRole('button',{name:/已报价/}));expect(change).toHaveBeenCalledWith({stage:'已报价'});
 fireEvent.click(screen.getByRole('button',{name:/约定下周确认测试结果/}));expect(jump).toHaveBeenCalledOnce();
});
it('does not invent a stage, tier or customer characteristics when no data exists',()=>{
 render(<CustomerCrmOverview customer={{...customer,stage:'',tier:'',tags:[],nextFollowUp:0,followUps:[]}} mail={[]} onChange={()=>{}} onShowActivity={()=>{}}/>);
 expect(screen.getByText('未设置阶段')).toBeTruthy();expect(screen.getByText('尚未标记特点，不根据零散信息猜测')).toBeTruthy();expect(screen.getByText('暂无往来记录')).toBeTruthy();
 expect(within(screen.getByRole('group',{name:'跟进阶段'})).getAllByRole('button').every(b=>b.getAttribute('aria-pressed')==='false')).toBe(true);
});
it('formats a local calendar date without UTC off-by-one conversion',()=>{expect(localDateValue(new Date(2031,0,9,0,0,0).getTime())).toBe('2031-01-09');expect(localDateValue(0)).toBe('');});
it('keeps the next planned action in the overview even when the workspace becomes single column',()=>{
 render(<CustomerCrmOverview customer={customer} mail={[]} planSummary="下一步：确认样品测试结果" onChange={()=>{}} onShowActivity={()=>{}}/>);
 const next=screen.getByText('下一步：确认样品测试结果');expect(next.closest('details')).toBeNull();expect(next.closest('.crm-overview')).toBeTruthy();
});
