import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import RobotAvatar from './RobotAvatar.vue'
afterEach(()=>vi.useRealTimers())
function setup(state='idle',play=vi.fn(()=>Promise.resolve())){
 const api={applyEmotion:play,dispose:vi.fn()}
 const w=mount(RobotAvatar,{props:{state:state as any},attachTo:document.body})
 Object.assign(w.find('iframe').element.contentWindow!,api)
 return {w,api,load:()=>w.find('iframe').trigger('load')}
}
describe('IP animation playback',()=>{
 it('maps continuous speech to sound bars without finishing the business state',async()=>{
  const {w,api,load}=setup('speaking');await load();await flushPromises()
  expect(api.applyEmotion).toHaveBeenLastCalledWith('waiting-wave')
  expect(w.emitted('action-complete')).toBeUndefined();w.unmount()
 })
 it('maps received and thinking, and waits for action completion',async()=>{
  let finish!:()=>void
  const {w,api,load}=setup('received',vi.fn(()=>new Promise<void>(r=>{finish=r})))
  await load();expect(api.applyEmotion).toHaveBeenLastCalledWith('affirm');expect(w.emitted('action-complete')).toBeUndefined()
  finish();await flushPromises();expect(w.emitted('action-complete')).toHaveLength(1)
  await w.setProps({state:'thinking'});expect(api.applyEmotion).toHaveBeenLastCalledWith('waiting-spin');w.unmount();expect(api.dispose).toHaveBeenCalledOnce()
 })
 it('rejects stale completion after another request',async()=>{
  let finish!:()=>void;const {w,load}=setup('failure',vi.fn((action:string)=>action==='failure'?new Promise<void>(r=>{finish=r}):Promise.resolve()))
  await load();await w.setProps({state:'thinking'});finish();await flushPromises();expect(w.emitted('action-complete')).toBeUndefined();w.unmount()
 })
 it('random idle sleep is followed by wake, and all timers stop on a request/unmount',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0)
  const {w,api,load}=setup();await load();await flushPromises()
  await vi.advanceTimersByTimeAsync(6000);expect(api.applyEmotion).toHaveBeenLastCalledWith('sleep')
  await vi.advanceTimersByTimeAsync(4500);expect(api.applyEmotion).toHaveBeenLastCalledWith('wake')
  await w.setProps({state:'thinking'});const count=api.applyEmotion.mock.calls.length
  await vi.advanceTimersByTimeAsync(30000);expect(api.applyEmotion).toHaveBeenCalledTimes(count)
  w.unmount();expect(vi.getTimerCount()).toBe(0);vi.restoreAllMocks()
 })
})
