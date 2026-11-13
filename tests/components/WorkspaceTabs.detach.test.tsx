import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkspaceTabs from '../../src/components/WorkspaceTabs';
import { shouldDetachMailTab } from '../../src/components/mailTabDrag';

const h = vi.hoisted(()=>({open:vi.fn(),close:vi.fn(),select:vi.fn(),detail:vi.fn(),navigate:vi.fn(),toast:vi.fn(),scope:vi.fn(),
  mail:{openMessageIds:['m1'],selectedMessageId:'m1' as string|null},
  ui:{activeView:'starred',messageDetailId:null as string|null,navTabs:[],aiBgTask:null},
  compose:{tabs:[],activeTabId:null}}));
vi.mock('../../src/lib/api',()=>({openMailWindow:h.open}));
vi.mock('../../src/hooks/queries',()=>({useMessageQuery:(id:string)=>({data:{id,subject:`Subject ${id}`}})}));
vi.mock('../../src/stores/mail.store',()=>({useMailStore:Object.assign((s:any)=>s({...h.mail,closeMessageTab:h.close}),{getState:()=>({...h.mail,closeMessageTab:h.close,setSelectedMessage:h.select,setSearchScope:h.scope})})}));
vi.mock('../../src/stores/ui.store',()=>({useUIStore:Object.assign((s:any)=>s(h.ui),{getState:()=>({...h.ui,setMessageDetailId:h.detail,navigateToView:h.navigate})})}));
vi.mock('../../src/stores/compose.store',()=>({useComposeStore:Object.assign((s:any)=>s(h.compose),{getState:()=>h.compose})}));
vi.mock('../../src/stores/toast.store',()=>({useToastStore:{getState:()=>({addToast:h.toast})}}));

beforeEach(()=>{
  vi.clearAllMocks(); h.open.mockReset().mockResolvedValue(undefined);
  h.mail.openMessageIds=['m1'];h.mail.selectedMessageId='m1';h.ui.activeView='starred';h.ui.messageDetailId=null;
  class Pointer extends MouseEvent { readonly pointerId:number; constructor(type:string,init:PointerEventInit={}) {super(type,init);this.pointerId=init.pointerId??1;} }
  vi.stubGlobal('PointerEvent',Pointer);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function setup() {
  const view = render(<WorkspaceTabs/>);
  const strip = view.container.querySelector('[data-workspace-tabs]')!;
  vi.spyOn(strip,'getBoundingClientRect').mockReturnValue({left:0,right:1000,top:36,bottom:76,width:1000,height:40,x:0,y:36,toJSON:()=>{}});
  return screen.getByRole('button',{name:'Subject m1'});
}
function drag(tab:HTMLElement,endY=180) {
  fireEvent.pointerDown(tab,{button:0,pointerId:1,clientX:100,clientY:55});
  fireEvent.pointerMove(tab,{buttons:1,pointerId:1,clientX:130,clientY:endY});
  fireEvent.pointerUp(tab,{button:0,pointerId:1,clientX:130,clientY:endY});
}
it('opens a starred-origin tab in exact detail, not the previous inbox folder',()=>{
  fireEvent.click(setup());expect(h.select).toHaveBeenCalledWith('m1');expect(h.detail).toHaveBeenCalledWith('m1');expect(h.navigate).toHaveBeenCalledWith('messageDetail');
});
it('detaches on release outside the strip and closes original only after success',async()=>{
  let finish!:()=>void;
  h.open.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  drag(setup());
  expect(h.open).toHaveBeenCalledExactlyOnceWith('m1');expect(h.close).not.toHaveBeenCalled();
  await act(async()=>finish());
  expect(h.close).toHaveBeenCalledExactlyOnceWith('m1');
});
it('retains the original tab and explains a native window failure',async()=>{
  h.open.mockRejectedValue(new Error('Example native failure'));
  drag(setup());
  await waitFor(()=>expect(h.toast).toHaveBeenCalled());
  expect(h.close).not.toHaveBeenCalled();expect(h.toast.mock.calls[0][0].message).toContain('原标签仍保留');
});
it('does not detach on a click, small jitter or a drag inside the strip',()=>{
  const tab=setup();drag(tab,60);expect(h.open).not.toHaveBeenCalled();
  expect(shouldDetachMailTab({x:10,y:10},{x:11,y:12},{left:0,right:20,top:0,bottom:5})).toBe(false);
});
it('allows Escape and pointer cancel to abort without a new window',()=>{
  const tab=setup();
  fireEvent.pointerDown(tab,{button:0,pointerId:1,clientX:100,clientY:55});
  fireEvent.pointerMove(tab,{buttons:1,pointerId:1,clientX:130,clientY:180});
  fireEvent.keyDown(window,{key:'Escape'});
  fireEvent.pointerUp(tab,{pointerId:1,clientX:130,clientY:180});
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.pointerDown(tab,{button:0,pointerId:1,clientX:100,clientY:55});
  fireEvent.pointerCancel(tab,{pointerId:1});
  fireEvent.pointerUp(tab,{pointerId:1,clientX:130,clientY:180});
  expect(h.open).not.toHaveBeenCalled();
});
it('offers a keyboard-accessible native-window context command',async()=>{
  fireEvent.contextMenu(setup(),{clientX:100,clientY:55});
  fireEvent.click(screen.getByRole('menuitem',{name:'在独立窗口打开'}));
  await waitFor(()=>expect(h.close).toHaveBeenCalledWith('m1'));
  expect(h.open).toHaveBeenCalledWith('m1');
});
it('does not start a detach gesture from the close icon',()=>{
  const tab=setup();
  const close=tab.querySelector('[role="button"]') as HTMLElement;
  drag(close);expect(h.open).not.toHaveBeenCalled();
});
it('does not reveal an old account overview when the last mail is detached',async()=>{
  h.ui.activeView='messageDetail';h.ui.messageDetailId='m1';h.mail.selectedMessageId=null;
  drag(setup());await waitFor(()=>expect(h.close).toHaveBeenCalledWith('m1'));
  expect(h.scope).toHaveBeenCalledWith(null);expect(h.navigate).toHaveBeenCalledWith('inbox');
});
