import {expect,it} from 'vitest';
import {orderByLeadSignals} from './leadSignalOrder';
const signal={kind:'trade_activity',sourceUrl:'https://example.org/trade',quote:'Publicly reported component imports',summary:'Component imports',observedAt:1};
it('never lets more trade records outrank a better business match',()=>{
 const good={id:'match',quality:{level:'source_matched',score:60},buyingSignals:[]};
 const weak={id:'weak',quality:{level:'needs_review',score:99},buyingSignals:[signal]};
 expect(orderByLeadSignals([weak,good]).map(i=>i.id)).toEqual(['match','weak']);
});
it('prioritizes sourced signals within the same match group and keeps all candidates',()=>{
 const ordinary={id:'ordinary',quality:{level:'channel_candidate',score:70},buyingSignals:[]};
 const evidence={...ordinary,id:'evidence',buyingSignals:[signal]};
 expect(orderByLeadSignals([ordinary,evidence]).map(i=>i.id)).toEqual(['evidence','ordinary']);
});
it('does not count source-less prose as a procurement signal',()=>{
 const a={id:'a',quality:{level:'channel_candidate',score:60}};
 const b={...a,id:'b',buyingSignals:[{...signal,sourceUrl:''}]};
 expect(orderByLeadSignals([a,b]).map(i=>i.id)).toEqual(['a','b']);
});
it('uses real replies as feedback within a match tier without changing requirements or removing companies',()=>{
 const a={id:'ordinary',quality:{level:'channel_candidate',score:70},emails:['a@example.org']};
 const b={...a,id:'replied',emails:['b@example.org']};
 const weak={...b,id:'uncertain',quality:{level:'needs_review',score:90}};
 const original=[a,weak,b];
 expect(orderByLeadSignals(original,e=>e==='b@example.org'?'replied':undefined).map(i=>i.id)).toEqual(['replied','ordinary','uncertain']);
 expect(original.map(i=>i.id)).toEqual(['ordinary','uncertain','replied']);
});
