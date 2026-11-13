import {beforeEach,expect,it,vi} from 'vitest';
import {researchCompany} from '../../src/lib/api';
const h=vi.hoisted(()=>({invoke:vi.fn(),channels:[] as Array<{onmessage:(stage:string)=>void}>}));
vi.mock('@tauri-apps/api/core',()=>({invoke:h.invoke,Channel:class{onmessage=(_stage:string)=>{};constructor(){h.channels.push(this);}}}));
beforeEach(()=>{vi.clearAllMocks();h.channels.length=0;h.invoke.mockResolvedValue({id:'anonymous'});});
it('uses native stages on the same investigation call, not extra searches',async()=>{
 const stage=vi.fn();await researchCompany('Sample Devices','https://sample.invalid','Germany',' DE123 ',stage);
 expect(h.invoke).toHaveBeenCalledTimes(1);expect(h.invoke).toHaveBeenCalledWith('research_company',{companyName:'Sample Devices',website:'https://sample.invalid',country:'Germany',vat:'DE123',onProgress:h.channels[0]});
 h.channels[0].onmessage('正在读取外部证据');expect(stage).toHaveBeenCalledWith('正在读取外部证据');
});
it('preserves callers which do not subscribe to progress',async()=>{
 await researchCompany('Sample Devices','','');expect(h.channels).toHaveLength(0);
 expect(h.invoke).toHaveBeenCalledWith('research_company',{companyName:'Sample Devices',website:'',country:'',vat:null,onProgress:null});
});
