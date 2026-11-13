import { create } from 'zustand';
import { loadResearchEmailChecks,prescreenResearchEmails,verifyResearchEmail,type ResearchEmailCheck } from '@/lib/api';
import { extractErrorMessage } from '@/lib/extractErrorMessage';

export const emailCheckKey=(email:string)=>email.trim().toLowerCase();
const loading=new Set<string>();
const loadedAt=new Map<string,number>();
let stopRequested=false;
let feedbackReading:Promise<void>|undefined;
const feedbackPending=new Set<string>();
export function refreshEmailFeedback(emails?:string[]):Promise<void>{
  for(const email of emails??Object.keys(useEmailChecks.getState().records))feedbackPending.add(emailCheckKey(email));
  if(feedbackReading)return feedbackReading;
  feedbackReading=(async()=>{
    while(feedbackPending.size){const batch=[...feedbackPending].slice(0,200);batch.forEach(e=>feedbackPending.delete(e));
      const rows=await loadResearchEmailChecks(batch);useEmailChecks.setState(s=>({records:merge(s.records,rows)}));}
  })().finally(()=>{feedbackReading=undefined;});return feedbackReading;
}
function merge(old:Record<string,ResearchEmailCheck>,fresh:Record<string,ResearchEmailCheck>) {
  const next={...old};
  for(const [key,row] of Object.entries(fresh)){
    const before=next[key]||{};
    next[key]={
      screen:row.screen && row.screen.checkedAt>=(before.screen?.checkedAt||0) ? row.screen : before.screen,
      verification:row.verification && row.verification.checkedAt>=(before.verification?.checkedAt||0) ? row.verification : before.verification,
      feedback:row.feedback && row.feedback.recordedAt>=(before.feedback?.recordedAt||0) ? row.feedback : before.feedback,
    };
  }
  return next;
}
export const useEmailChecks=create<{
  records:Record<string,ResearchEmailCheck>; screening:boolean; busy:boolean; progress:string; error:string;
  screen:(emails:string[])=>Promise<void>;
  verify:(emails:string[],refresh:boolean)=>Promise<void>;
  stop:()=>void;
}>((set,get)=>({
  records:{},screening:false,busy:false,progress:'',error:'',
  screen:async emails=>{
    const requested=[...new Set(emails.map(emailCheckKey).filter(Boolean))].filter(e=>!loading.has(e) && Date.now()-(loadedAt.get(e)||0)>60_000);
    if(!requested.length)return;
    requested.forEach(e=>loading.add(e));set({screening:true});
    try {
      for(let index=0;index<requested.length;index+=200){
        const batch=requested.slice(index,index+200);
        const old=await loadResearchEmailChecks(batch);set(s=>({records:merge(s.records,old)}));
        const next=await prescreenResearchEmails(batch);set(s=>({records:merge(s.records,next)}));
        batch.forEach(e=>loadedAt.set(e,Date.now()));
      }
    }catch(error){set({error:`基础初筛未完成：${extractErrorMessage(error)}；没有把这些邮箱判成无效。`});}
    finally{requested.forEach(e=>loading.delete(e));set({screening:loading.size>0});}
  },
  verify:async(emails,refresh)=>{
    if(get().busy)return;
    const unique=[...new Set(emails.map(emailCheckKey).filter(Boolean))];
    stopRequested=false;set({busy:true,error:'',progress:`准备验证 ${unique.length} 个邮箱`});
    let done=0;
    try {
      for(const email of unique){
        if(stopRequested)break;
        set({progress:`正在验证 ${done+1}/${unique.length}：${email}`});
        const verification=await verifyResearchEmail(email,refresh);
        set(s=>({records:merge(s.records,{[email]:{verification}})}));done+=1;
      }
      set({progress:`${stopRequested?'已停止后续验证':'验证完成'}：${done}/${unique.length}`});
    }catch(error){set({error:`已停止后续验证：${extractErrorMessage(error)}。已取得的结果保留。`,progress:`已完成 ${done}/${unique.length}`});}
    finally{set({busy:false});}
  },
  stop:()=>{stopRequested=true;set({progress:'正在停止；等待当前邮箱返回后不再验证后续邮箱…'});},
}));
