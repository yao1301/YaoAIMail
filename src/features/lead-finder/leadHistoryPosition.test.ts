import { expect, it } from 'vitest';
import { anchorHistoryPosition, clampHistoryPosition } from './leadHistoryPosition';
it('opens right aligned below the current button rather than at the screen origin',()=>{
  expect(anchorHistoryPosition({left:800,right:920,top:60,bottom:94},{width:520,height:400},{width:1200,height:800})).toEqual({left:400,top:100,maxHeight:560});
});
it('flips above a low button and clamps near the screen edges',()=>{
  const p=anchorHistoryPosition({left:30,right:140,top:700,bottom:734},{width:520,height:400},{width:1200,height:800});
  expect(p.left).toBe(10);expect(p.top).toBe(294);
  expect(clampHistoryPosition({left:2000,top:-80},{width:520,height:400},{width:1200,height:800})).toEqual({left:670,top:10});
});
it('fits a short viewport without covering its edges',()=>{
  const p=anchorHistoryPosition({left:220,right:330,top:40,bottom:70},{width:350,height:480},{width:375,height:320});
  expect(p.left).toBe(10);expect(p.top).toBe(76);expect(p.top+p.maxHeight).toBeLessThanOrEqual(310);
});
