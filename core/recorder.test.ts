import { describe, expect, it } from 'vitest'
import { supportsRecording } from './recorder'

describe('recorder', () => {
  it('reports unsupported in non-secure / headless environments', () => {
    // jsdom 无 getUserMedia；真实浏览器（https/localhost）下为 true。
    // 采集与 WAV 编码逻辑由浏览器手测覆盖（demo 页按住说话）。
    expect(supportsRecording()).toBe(false)
  })
})
