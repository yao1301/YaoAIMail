import type {BuyingSignal} from '@/lib/researchEvidence';
type Lead={quality?:{level:string;score:number};buyingSignals?:BuyingSignal[];emails?:string[]};
/** Business fit always precedes signal volume. No industry/market/company overrides. */
export function orderByLeadSignals<T extends Lead>(items:T[],feedback?:(email:string)=>string|undefined):T[]{
  const fit=(item:T)=>item.quality?.level==='source_matched'?2:item.quality?.level==='channel_candidate'?1:0;
  const signals=(item:T)=>Math.min(3,new Set((item.buyingSignals||[]).filter(s=>s.quote.trim().length>0 && /^https?:\/\//i.test(s.sourceUrl)).map(s=>`${s.sourceUrl}\n${s.quote}`)).size);
  const replied=(item:T)=>Number((item.emails||[]).some(e=>feedback?.(e)==='replied'));
  return items.map((item,index)=>({item,index})).sort((a,b)=>fit(b.item)-fit(a.item)||replied(b.item)-replied(a.item)||signals(b.item)-signals(a.item)||(b.item.quality?.score||0)-(a.item.quality?.score||0)||a.index-b.index).map(p=>p.item);
}
