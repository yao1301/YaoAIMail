import { expect,it,vi } from 'vitest';
import { leadPage,leadTaskContext } from './leadDelivery';
it('delivers twenty rows per page without labelling small search batches as pages',()=>{
  const all=Array.from({length:46},(_,i)=>i);
  expect(leadPage(all,1).items).toHaveLength(20);expect(leadPage(all,2).items).toEqual(all.slice(20,40));
  expect(leadPage(all,3).items).toEqual(all.slice(40));expect(leadPage(all,99).page).toBe(3);
  expect(leadPage(all.slice(0,6),1).pages).toBe(1);expect(leadPage([],1).items).toEqual([]);
});
it('does not reread or append selected mail and documents on continuation',async()=>{
  const snapshot={contextText:'Original document',contextFiles:['Product.pdf'],contextKnowledgeIds:['k1'],contextFilesNote:'Product.pdf'};
  const read=vi.fn();expect(await leadTaskContext(2,snapshot,read)).toEqual(snapshot);
  expect(await leadTaskContext(3,snapshot,read)).toEqual(snapshot);expect(read).not.toHaveBeenCalled();
});
it('builds a fresh snapshot on a new task and preserves intentionally empty snapshots',async()=>{
  const fresh={contextText:'new',contextFiles:[],contextKnowledgeIds:[],contextFilesNote:''};const read=vi.fn().mockResolvedValue(fresh);
  expect(await leadTaskContext(1,{contextText:'old'},read)).toBe(fresh);expect(read).toHaveBeenCalledOnce();
  await leadTaskContext(2,{contextText:''},read);expect(read).toHaveBeenCalledOnce();
});
