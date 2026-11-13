import {useEffect,useRef,useState} from 'react';
import {BookmarkPlus,ChevronDown,Trash2} from 'lucide-react';
import {deleteResearchProfile,listResearchProfiles,saveResearchProfile,type ResearchProfile} from '@/lib/api';
import './LeadProfiles.css';
type Conditions=Pick<ResearchProfile,'product'|'market'|'buyerType'|'requirements'>;
export default function LeadProfiles({scopeId,current,apply}:{scopeId:string;current:Conditions;apply:(profile:Conditions)=>void}){
  const [profiles,setProfiles]=useState<ResearchProfile[]>([]),[name,setName]=useState(''),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false);
  const details=useRef<HTMLDetailsElement>(null),scope=useRef(scopeId);scope.current=scopeId;
  useEffect(()=>{
    let alive=true;setProfiles([]);setName('');setError('');setBusy(false);setSaved(false);
    if(details.current)details.current.open=false;
    void listResearchProfiles(scopeId).then(next=>{if(alive)setProfiles(rows=>[...next,...rows.filter(row=>!next.some(p=>p.id===row.id))]);}).catch(()=>{if(alive)setError('暂时无法读取已保存条件，不影响搜索');});
    return()=>{alive=false;};
  },[scopeId]);
  async function save(){
    const account=scopeId;setBusy(true);setError('');setSaved(false);
    const profile:ResearchProfile={...current,id:crypto.randomUUID(),scopeId:account,name:(name.trim()||[current.product,current.market].filter(Boolean).join(' · ')||current.requirements.trim().slice(0,32)||'搜索条件').slice(0,60)};
    try{
      await saveResearchProfile(profile);
      if(scope.current!==account)return;
      setProfiles(rows=>[...rows,profile]);setName('');setSaved(true);
    }catch{if(scope.current===account)setError('保存失败，请重试');}
    finally{if(scope.current===account)setBusy(false);}
  }
  async function remove(profile:ResearchProfile){
    const account=scopeId;setBusy(true);setError('');setSaved(false);
    try{await deleteResearchProfile(profile.id,account);if(scope.current===account)setProfiles(rows=>rows.filter(p=>p.id!==profile.id));}
    catch{if(scope.current===account)setError('删除失败，请重试');}
    finally{if(scope.current===account)setBusy(false);}
  }
  // Reuse the encrypted preset schema; do not migrate or erase existing saves.
  return <details ref={details} className="lead-search-presets" onKeyDown={event=>{if(event.key==='Escape'&&details.current){details.current.open=false;details.current.querySelector('summary')?.focus();}}}>
    <summary><BookmarkPlus size={14}/>保存搜索条件<ChevronDown size={13} className="lead-search-presets__chevron"/></summary>
    <div className="lead-search-presets__panel">
      <p>保存本次条件，下次点名称即可填入，不会自动开始搜索。</p>
      <div className="lead-search-presets__save">
        <input aria-label="搜索条件名称" placeholder="名称（可不填，自动命名）" value={name} maxLength={60} onChange={event=>{setName(event.target.value);setSaved(false);}}/>
        <button type="button" disabled={busy||(!current.product.trim()&&!current.requirements.trim())} onClick={()=>void save()}>{busy?'处理中…':'保存'}</button>
      </div>
      {saved&&<p role="status">已保存，下次可直接点名称使用。</p>}
      {profiles.length>0&&<ul aria-label="已保存的搜索条件">{profiles.map(profile=><li key={profile.id}>
        <button type="button" className="lead-search-presets__use" disabled={busy} title="点击填入搜索条件" onClick={()=>{apply(profile);if(details.current)details.current.open=false;}}>{profile.name}</button>
        <button type="button" className="lead-search-presets__delete" disabled={busy} aria-label={`删除搜索条件 ${profile.name}`} title="删除这组条件" onClick={()=>void remove(profile)}><Trash2 size={13}/></button>
      </li>)}</ul>}
      {error&&<p role="alert">{error}</p>}
    </div>
  </details>;
}
