import { afterEach, describe, expect, it, vi } from 'vitest'
import source from './eyes-adapter.js?raw'
let api:any
function setup(){
 let now=0,raf:FrameRequestCallback|undefined
 vi.spyOn(performance,'now').mockImplementation(()=>now)
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{raf=cb;return 1})
 vi.stubGlobal('cancelAnimationFrame',vi.fn())
 new Function(source)();api=window as any
 const advance=(ms:number)=>{const end=now+ms;while(now<end){now+=16;raf?.(now)}}
 const radius=()=>[...document.querySelectorAll('ellipse')].map(el=>[Number(el.getAttribute('rx')),Number(el.getAttribute('ry'))])
 return {advance,radius}
}
afterEach(()=>{api?.dispose?.();vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('focused transparent eye renderer',()=>{
 it('crossfades to five moving sound bars and restores eyes after playback',()=>{
  const v=setup();api.applyEmotion('waiting-wave');v.advance(600)
  const bars=[...document.querySelectorAll('svg > g:last-child rect')]
  expect(bars).toHaveLength(5)
  const before=bars.map(el=>el.getAttribute('height'))
  expect(Number(bars[0].parentElement!.getAttribute('opacity'))).toBeGreaterThan(.99)
  v.advance(250);expect(bars.map(el=>el.getAttribute('height'))).not.toEqual(before)
  api.applyEmotion('idle');v.advance(800)
  expect(Number(bars[0].parentElement!.getAttribute('opacity'))).toBeLessThan(.01)
  expect(v.radius()[0][0]/v.radius()[0][1]).toBeLessThan(.7)
 })
 it('morphs to circular waiting eyes and restores ellipses continuously',()=>{
  const v=setup();expect(v.radius()[0]).toEqual([18.9,29])
  api.applyEmotion('waiting-spin');v.advance(1600)
  for(const [x,y] of v.radius())expect(Math.abs(x-y)).toBeLessThan(.00001)
  const before=v.radius()[0];api.applyEmotion('idle');expect(v.radius()[0]).toEqual(before)
  v.advance(16);expect(Math.abs(v.radius()[0][0]-before[0])).toBeLessThan(4)
  v.advance(800);expect(v.radius()[0][0]/v.radius()[0][1]).toBeLessThan(.7)
 })
 it('has transparent eyelids and wakes from the displayed sleeping pose without resetting',()=>{
  const v=setup();api.applyEmotion('sleep');v.advance(2400);expect(v.radius()[0][1]).toBeLessThan(3)
  const before=v.radius()[0];api.applyEmotion('wake');expect(v.radius()[0]).toEqual(before)
  v.advance(1200);expect(v.radius()[0][1]).toBeGreaterThan(28)
  expect([...document.querySelectorAll('rect[fill="black"]')].every(el=>el.closest('mask'))).toBe(true)
  expect(document.querySelectorAll('mask')).toHaveLength(2)
 })
})
