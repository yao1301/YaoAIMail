import {describe,expect,it} from 'vitest';
import {leadFillStatus,leadPageDeficit} from './leadDelivery';
describe('fill the actual delivery page',()=>{
 it('asks for remaining slots, not another nominal twenty',()=>{expect(leadPageDeficit(3)).toBe(17);expect(leadPageDeficit(18)).toBe(2);expect(leadPageDeficit(20)).toBe(20);expect(leadPageDeficit(39)).toBe(1);});
 it('never presents three as a completed twenty',()=>{expect(leadFillStatus(3,false,'time_limit')).toContain('3/20');expect(leadFillStatus(3,false,'time_limit')).toContain('尚未满页');expect(leadFillStatus(3,true)).toContain('继续补充');});
 it('only marks twenty as full and provides incomplete stopping reasons',()=>{expect(leadFillStatus(20,false)).toBe('本页已找到 20 家');expect(leadFillStatus(22,false,'no_progress')).toContain('连续多轮');});
});
