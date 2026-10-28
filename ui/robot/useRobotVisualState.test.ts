import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import type { ExplainStateSnapshot } from '../../core/ExplainController'
import { useRobotVisualState } from './useRobotVisualState'
const snap=(patch:Partial<ExplainStateSnapshot>={})=>({phase:'idle',answerStatus:'none',voiceState:'idle',error:null,lines:[],answerLines:[],answerText:'',...patch} as ExplainStateSnapshot)
const line={lineId:'1',speaker:'A',text:'已生成的讲解。'}
function setup(initial=snap()){
 const snapshot=shallowRef<ExplainStateSnapshot|null>(initial),scope=effectScope()
 return {snapshot,...scope.run(()=>useRobotVisualState(snapshot))!,stop:()=>scope.stop()}
}
describe('IP business animation lifecycle',()=>{
 it('waves only while main or answer speech is playing, and stops on pause',()=>{
  const v=setup(snap({phase:'playing'}));expect(v.state.value).toBe('speaking')
  v.snapshot.value=snap({phase:'paused'});expect(v.state.value).toBe('idle')
  v.snapshot.value=snap({phase:'answering',answerStatus:'playing'});expect(v.state.value).toBe('speaking')
  v.snapshot.value=snap({phase:'answering',answerStatus:'paused'});expect(v.state.value).toBe('idle');v.stop()
 })
 it('waits for main content, switches directly from loading to speech without success',()=>{
  const v=setup();expect(v.state.value).toBe('idle');v.snapshot.value=snap({phase:'generating'});expect(v.state.value).toBe('thinking')
  v.snapshot.value=snap({phase:'interpreting',lines:[line]});expect(v.state.value).toBe('idle')
  v.snapshot.value=snap({phase:'playing',lines:[line]});expect(v.state.value).toBe('speaking');expect(v.idleEnabled.value).toBe(false)
  v.finishAction();expect(v.state.value).toBe('speaking');v.stop()
 })
 it('acknowledges a sent message before thinking; late completion cannot override another question',()=>{
  const v=setup();v.snapshot.value=snap({phase:'answering',answerStatus:'analyzing',questionText:'问题一',activeGroupId:'1'})
  expect(v.state.value).toBe('received');v.finishAction();expect(v.state.value).toBe('thinking')
  v.snapshot.value=snap({phase:'answering',answerStatus:'playing',answerLines:[line]});expect(v.state.value).toBe('speaking')
  v.snapshot.value=snap({phase:'answering',answerStatus:'analyzing',questionText:'问题二',activeGroupId:'2'});expect(v.state.value).toBe('received');expect(v.revision.value).toBe(2)
  v.stop()
 })
 it('keeps acknowledgement visible for a fast answer, then directly plays sound bars without spurious waiting',()=>{
  const v=setup(snap({phase:'answering',answerStatus:'analyzing'}))
  v.snapshot.value=snap({phase:'answering',answerStatus:'playing',answerLines:[line]});expect(v.state.value).toBe('received')
  v.snapshot.value=snap({phase:'answering',answerStatus:'playing',answerLines:[line],currentTime:1});expect(v.state.value).toBe('received')
  v.finishAction();expect(v.state.value).toBe('speaking');v.finishAction();expect(v.state.value).toBe('speaking');v.stop()
 })
 it('plays a failure once and does not repeatedly retrigger for the same error',()=>{
  const v=setup(snap({phase:'generating'})),failed=snap({phase:'error',error:{kind:'generate-failed',message:'failed'}})
  v.snapshot.value=failed;expect(v.state.value).toBe('failure');v.finishAction();expect(v.state.value).toBe('idle')
  v.snapshot.value={...failed,currentTime:1};expect(v.state.value).toBe('idle');v.stop()
 })
 it('queues failure behind acknowledgement; cancellations and empty results do not celebrate',()=>{
  const v=setup(snap({phase:'answering',answerStatus:'analyzing'}));v.snapshot.value=snap({phase:'error'});expect(v.state.value).toBe('received');v.finishAction();expect(v.state.value).toBe('failure');v.stop()
  for(const next of [snap({phase:'paused',lines:[line]}),snap({phase:'interpreting'})]){const c=setup(snap({phase:'generating'}));c.snapshot.value=next;expect(c.state.value).toBe('idle');c.stop()}
 })
})
