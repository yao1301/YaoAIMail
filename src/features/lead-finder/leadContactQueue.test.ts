import { describe,expect,it } from "vitest";
import { LeadContactQueue,mergeContactProgress,contactJobKey,shouldDiscoverContact,type ContactProgress } from "./leadContactQueue";
describe("lead contact discovery",()=>{
  it("serves more than the first six admitted companies with a shared concurrency limit",async()=>{
    const q=new LeadContactQueue(3);let active=0,max=0;const served:number[]=[];
    await Promise.all(Array.from({length:17},(_,index)=>q.run(async()=>{
      active++;max=Math.max(max,active);await Promise.resolve();served.push(index);active--;
    })));
    expect(max).toBeLessThanOrEqual(3);expect(served).toHaveLength(17);expect(new Set(served).size).toBe(17);
  });
  it("a failure releases its slot and does not strand the rest",async()=>{
    const q=new LeadContactQueue(1);
    const values=await Promise.allSettled([q.run(async()=>{throw Error("fixture");}),q.run(async()=>"next")]);
    expect(values[1]).toEqual({status:"fulfilled",value:"next"});
  });
  it("late discovery snapshots preserve completed email evidence and in-flight state",()=>{
    const done:ContactProgress={emailDiscoveryStatus:"completed",emails:["sales@acme.example"],emailEvidence:[{sourceUrl:"https://acme.example/contact"}],contactStatus:"可联系",contacts:[{name:'Taylor Example'}],buyingSignals:[{kind:'business_role'}]};
    expect(mergeContactProgress(done,{emailDiscoveryStatus:"pending",emails:[],emailEvidence:[]})).toMatchObject(done);
    expect(mergeContactProgress({...done,emailDiscoveryStatus:"running"},{emails:[]} as ContactProgress).emailDiscoveryStatus).toBe("running");
  });
  it("an actual new completion can clear stale emails",()=>{
    expect(mergeContactProgress({emails:["stale@acme.example"],emailDiscoveryStatus:"completed"},{emails:[],emailEvidence:[],emailDiscoveryStatus:"completed"} as ContactProgress).emails).toEqual([]);
  });
  it("the same company in another search session is not stranded by an in-flight job",()=>{
    expect(contactJobKey("session-a","site:acme.example")).not.toBe(contactJobKey("session-b","site:acme.example"));
  });
  it("failed calls do not automatically retry on every later progress snapshot",()=>{
    expect(shouldDiscoverContact({emailDiscoveryStatus:"pending"})).toBe(true);
    expect(shouldDiscoverContact({emailDiscoveryStatus:"failed"})).toBe(false);
    expect(shouldDiscoverContact({emailDiscoveryStatus:"failed"},true)).toBe(true);
    expect(shouldDiscoverContact({emailDiscoveryStatus:"completed"})).toBe(false);
  });
});
