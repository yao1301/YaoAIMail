import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LeadTaskHistory from './LeadTaskHistory';
const tasks=Array.from({length:30},(_,i)=>({id:`task-${i}`,title:`任务 ${i}`,market:i===7?'Germany':'USA',resultCount:20,updatedAt:1720000000000+i}));
const originalShow=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'showModal');
const originalClose=Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,'close');
beforeEach(()=>{
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:vi.fn(function(this:HTMLDialogElement){this.open=true;})});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:vi.fn(function(this:HTMLDialogElement){this.open=false;})});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();
  if(originalShow)Object.defineProperty(HTMLDialogElement.prototype,'showModal',originalShow);else delete (HTMLDialogElement.prototype as any).showModal;
  if(originalClose)Object.defineProperty(HTMLDialogElement.prototype,'close',originalClose);else delete (HTMLDialogElement.prototype as any).close;
});
it('anchors to the trigger, supports header dragging and keyboard movement, and reopens at the button',()=>{
  const rect=(left:number,top:number,width:number,height:number)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON:()=>({})});
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){return this.classList.contains('lead-history-trigger')?rect(800,40,100,34):rect(0,0,520,400);});
  vi.stubGlobal('PointerEvent',class extends MouseEvent {pointerId:number;constructor(type:string,init:MouseEventInit & {pointerId?:number}={}){super(type,init);this.pointerId=init.pointerId??1;}});
  render(<LeadTaskHistory tasks={tasks} activeId={null} onSelect={vi.fn()} onDelete={vi.fn()}/>);
  const trigger=screen.getByRole('button',{name:'历史任务（30）'});fireEvent.click(trigger);
  const dialog=screen.getByRole('dialog') as HTMLDialogElement;expect(dialog.style.left).toBe('380px');expect(dialog.style.top).toBe('80px');
  const header=screen.getByLabelText('历史任务窗口位置');fireEvent.pointerDown(header,{button:0,pointerId:3,clientX:400,clientY:100});
  fireEvent.pointerMove(header,{pointerId:3,clientX:450,clientY:150});expect(dialog.style.left).toBe('430px');expect(dialog.style.top).toBe('130px');
  fireEvent.pointerUp(header,{pointerId:3});fireEvent.pointerMove(header,{pointerId:3,clientX:480,clientY:180});expect(dialog.style.left).toBe('430px');
  fireEvent.keyDown(header,{key:'ArrowLeft'});expect(dialog.style.left).toBe('420px');
  fireEvent.click(screen.getByRole('button',{name:'关闭历史任务'}));fireEvent.click(trigger);expect(dialog.style.left).toBe('380px');expect(dialog.style.top).toBe('80px');
});
it('keeps thirty history tasks out of the main flow and opens a separately scrollable dialog',()=>{
  const select=vi.fn();render(<LeadTaskHistory tasks={tasks} activeId="task-4" onSelect={select} onDelete={vi.fn()}/>);
  expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('button',{name:/任务 7/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'历史任务（30）'}));expect(screen.getByRole('dialog',{name:'历史任务'})).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox',{name:'筛选历史任务'}),{target:{value:'Germany'}});
  expect(screen.getByText('任务 7')).toBeTruthy();expect(screen.queryByText('任务 8')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/任务 7 Germany/}));expect(select).toHaveBeenCalledExactlyOnceWith(tasks[7]);expect(screen.queryByRole('dialog')).toBeNull();
});
it('closes without selecting and deletes without triggering task selection',()=>{
  const select=vi.fn(),remove=vi.fn();render(<LeadTaskHistory tasks={tasks} activeId={null} onSelect={select} onDelete={remove}/>);
  fireEvent.click(screen.getByRole('button',{name:'历史任务（30）'}));fireEvent.click(screen.getByRole('button',{name:'删除任务：任务 5'}));expect(remove).toHaveBeenCalledExactlyOnceWith('task-5');expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'关闭历史任务'}));expect(screen.queryByRole('dialog')).toBeNull();expect(select).not.toHaveBeenCalled();
});
it('handles an invalid legacy date without breaking all history results',()=>{
  render(<LeadTaskHistory tasks={[{...tasks[0],updatedAt:NaN}]} activeId={null} onSelect={vi.fn()} onDelete={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'历史任务（1）'}));expect(screen.getByText('时间未知')).toBeTruthy();
});
