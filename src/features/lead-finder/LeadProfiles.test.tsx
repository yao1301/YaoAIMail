import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({list:vi.fn(),save:vi.fn(),remove:vi.fn()}));
vi.mock('@/lib/api',()=>({listResearchProfiles:h.list,saveResearchProfile:h.save,deleteResearchProfile:h.remove}));
import LeadProfiles from './LeadProfiles';
const profile={id:'p1',scopeId:'a1',name:'Parts buyers',product:'industrial parts',market:'France',buyerType:'importer',requirements:'Exclude resellers'};
beforeEach(()=>{vi.resetAllMocks();h.list.mockResolvedValue([profile]);h.save.mockResolvedValue(undefined);h.remove.mockResolvedValue(undefined);});afterEach(cleanup);
function expand(){fireEvent.click(screen.getByText('保存搜索条件'));}
it('uses a saved account-scoped condition with one click and collapses, without running search',async()=>{
 const apply=vi.fn();const {container}=render(<LeadProfiles scopeId="a1" current={{product:'',market:'',buyerType:'',requirements:''}} apply={apply}/>);
 expect(container.querySelector('details')?.open).toBe(false);expand();
 fireEvent.click(await screen.findByRole('button',{name:'Parts buyers'}));
 expect(apply).toHaveBeenCalledWith(profile);expect(h.list).toHaveBeenCalledWith('a1');expect(container.querySelector('details')?.open).toBe(false);
 expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByText('应用画像')).toBeNull();
});
it('auto-names a save and persists only criteria, never credentials or mailbox context',async()=>{
 render(<LeadProfiles scopeId="a1" current={{product:'parts',market:'France',buyerType:'importer',requirements:'Exclude resellers'}} apply={()=>{}}/>);expand();
 await screen.findByRole('button',{name:'Parts buyers'});fireEvent.click(screen.getByRole('button',{name:'保存'}));
 await screen.findByRole('status');expect(h.save.mock.calls[0][0].name).toBe('parts · France');
 expect(Object.keys(h.save.mock.calls[0][0]).sort()).toEqual(['buyerType','id','market','name','product','requirements','scopeId'].sort());
 expect(screen.getByRole('button',{name:'parts · France'})).toBeTruthy();
});
it('deletes directly beside a saved condition without applying it',async()=>{
 const apply=vi.fn();render(<LeadProfiles scopeId="a1" current={{product:'',market:'',buyerType:'',requirements:''}} apply={apply}/>);expand();
 fireEvent.click(await screen.findByRole('button',{name:'删除搜索条件 Parts buyers'}));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Parts buyers'})).toBeNull());
 expect(h.remove).toHaveBeenCalledWith('p1','a1');expect(apply).not.toHaveBeenCalled();
});
it('does not leak late saved conditions into another account',async()=>{
 let finish!:(value:unknown)=>void;h.save.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const current={product:'parts',market:'France',buyerType:'importer',requirements:'Exclude resellers'};
 const view=render(<LeadProfiles scopeId="a1" current={current} apply={()=>{}}/>);expand();await screen.findByRole('button',{name:'Parts buyers'});
 fireEvent.click(screen.getByRole('button',{name:'保存'}));h.list.mockResolvedValue([]);
 view.rerender(<LeadProfiles scopeId="a2" current={current} apply={()=>{}}/>);
 await act(async()=>{finish(undefined);});expand();expect(screen.queryByRole('button',{name:'parts · France'})).toBeNull();expect(screen.queryByRole('button',{name:'Parts buyers'})).toBeNull();
});
it('shows a retryable error without losing conditions when deleting fails',async()=>{
 h.remove.mockRejectedValueOnce(new Error('offline'));render(<LeadProfiles scopeId="a1" current={{product:'',market:'',buyerType:'',requirements:''}} apply={()=>{}}/>);expand();
 fireEvent.click(await screen.findByRole('button',{name:'删除搜索条件 Parts buyers'}));await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Parts buyers'})).toBeTruthy();
});
it('does not let a late initial load erase a newly saved condition',async()=>{
 let finish!:(profiles:typeof profile[])=>void;h.list.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 render(<LeadProfiles scopeId="a1" current={{product:'parts',market:'France',buyerType:'importer',requirements:''}} apply={()=>{}}/>);expand();
 fireEvent.click(screen.getByRole('button',{name:'保存'}));await screen.findByRole('status');
 await act(async()=>{finish([profile]);});
 expect(screen.getByRole('button',{name:'parts · France'})).toBeTruthy();expect(screen.getByRole('button',{name:'Parts buyers'})).toBeTruthy();
});
