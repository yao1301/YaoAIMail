import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { History, Search, Trash2, X } from 'lucide-react';
import { anchorHistoryPosition, clampHistoryPosition, type HistoryPoint } from './leadHistoryPosition';
import './LeadFinderPresentation.css';

interface HistoryTask { id: string; title: string; market: string; resultCount: number; updatedAt: number; failure?: string; contextFilesNote?: string }
export default function LeadTaskHistory<T extends HistoryTask>({ tasks, activeId, onSelect, onDelete }: {
  tasks: T[]; activeId: string | null; onSelect: (task: T) => void; onDelete: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position,setPosition] = useState<HistoryPoint & {maxHeight:number}>({left:10,top:10,maxHeight:560});
  const positionRef=useRef(position);positionRef.current=position;
  const moved=useRef(false);
  const drag=useRef<{id:number;x:number;y:number;origin:HistoryPoint}|null>(null);
  const [filter, setFilter] = useState('');
  const visible = tasks.filter(task => `${task.title} ${task.market}`.toLowerCase().includes(filter.trim().toLowerCase()));
  function viewport(){return {width:window.innerWidth,height:window.innerHeight};}
  function panelSize(){const rect=dialog.current?.getBoundingClientRect();return {width:rect?.width || Math.min(520,window.innerWidth-20),height:rect?.height || 480};}
  function reposition(){
    if(!dialog.current?.open || !trigger.current)return;
    if(moved.current){setPosition(current=>({...current,...clampHistoryPosition(current,panelSize(),viewport()),maxHeight:Math.min(current.maxHeight,Math.max(120,window.innerHeight-20))}));}
    else setPosition(anchorHistoryPosition(trigger.current.getBoundingClientRect(),panelSize(),viewport()));
  }
  useLayoutEffect(()=>{reposition();},[filter,tasks.length]);
  useEffect(()=>{
    const onScroll=(event:Event)=>{if(event.target instanceof Node && dialog.current?.contains(event.target))return;reposition();};
    window.addEventListener('resize',reposition);window.addEventListener('scroll',onScroll,true);
    return()=>{window.removeEventListener('resize',reposition);window.removeEventListener('scroll',onScroll,true);};
  },[]);
  function moveTo(point:HistoryPoint){moved.current=true;setPosition(current=>({...current,...clampHistoryPosition(point,panelSize(),viewport())}));}
  function beginDrag(event:ReactPointerEvent<HTMLDivElement>){
    if(event.button!==0 || (event.target as HTMLElement).closest('button,input'))return;
    event.preventDefault();moved.current=true;drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,origin:positionRef.current};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  return <>
    <button ref={trigger} className="lead-history-trigger" type="button" onClick={() => { setFilter('');moved.current=false;drag.current=null;dialog.current?.showModal();reposition(); }}><History size={14} />历史任务（{tasks.length}）</button>
    <dialog className="lead-history-dialog" style={{left:position.left,top:position.top,maxHeight:position.maxHeight}} ref={dialog} aria-labelledby="lead-history-title" onClose={()=>{drag.current=null;}} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="lead-history-dialog__header" tabIndex={0} aria-label="历史任务窗口位置" title="按住标题栏拖动；方向键也可移动窗口" onPointerDown={beginDrag}
        onPointerMove={event=>{const start=drag.current;if(start?.id===event.pointerId)moveTo({left:start.origin.left+event.clientX-start.x,top:start.origin.top+event.clientY-start.y});}}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onLostPointerCapture={()=>{drag.current=null;}}
        onKeyDown={event=>{if(event.target!==event.currentTarget)return;const delta=event.shiftKey?30:10;const offsets:Record<string,[number,number]>={ArrowLeft:[-delta,0],ArrowRight:[delta,0],ArrowUp:[0,-delta],ArrowDown:[0,delta]};const offset=offsets[event.key];if(offset){event.preventDefault();moveTo({left:positionRef.current.left+offset[0],top:positionRef.current.top+offset[1]});}}}>
        <div><h2 id="lead-history-title">历史任务 <span aria-hidden="true">⠿</span></h2><p>选择任务直接查看结果 · 可拖动标题栏</p></div><button autoFocus type="button" aria-label="关闭历史任务" onClick={() => dialog.current?.close()}><X size={18} /></button>
      </div>
      <label className="lead-history-filter"><Search size={15} aria-hidden="true" /><input aria-label="筛选历史任务" placeholder="搜索任务名称、市场…" value={filter} onChange={event => setFilter(event.target.value)} /></label>
      <div className="lead-history-list">
        {!visible.length && <p className="lead-history-empty">{tasks.length ? '没有匹配的历史任务' : '还没有历史任务，开始搜索后会自动保存。'}</p>}
        {visible.map(task => <div key={task.id} className={`lead-history-row${activeId === task.id ? ' lead-history-row--active' : ''}`}>
          <button className="lead-history-row__select" type="button" onClick={() => { onSelect(task); dialog.current?.close(); }}>
            <span className="lead-history-row__title"><strong title={task.title}>{task.title}</strong>{activeId === task.id && <span>当前</span>}</span>
            <span className="lead-history-row__meta">{task.market || '未指定市场'} · {task.failure ? '未完成' : `${task.resultCount} 家公司`}{task.contextFilesNote ? ' · 含参考资料' : ''}</span>
            <time dateTime={Number.isFinite(task.updatedAt) && Math.abs(task.updatedAt)<8.64e15 ? new Date(task.updatedAt).toISOString() : undefined}>{Number.isFinite(task.updatedAt) && Math.abs(task.updatedAt)<8.64e15 ? new Date(task.updatedAt).toLocaleString() : '时间未知'}</time>
          </button>
          <button className="lead-history-row__delete" type="button" aria-label={`删除任务：${task.title}`} onClick={() => onDelete(task.id)}><Trash2 size={15} /></button>
        </div>)}
      </div>
    </dialog>
  </>;
}
