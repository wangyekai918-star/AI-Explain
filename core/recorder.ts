/**
 * AI 讲解按住说话录音（采集段移植自 feature/large-screen DigitalEmployee/asrClient.js）
 * ----------------------------------------------------------------------
 * 后端 ASR 为**整段上传式**（recognizeSpeech：base64 + format 一次返回文本），
 * 因此本组件不搬大屏版的火山 SAUC 流式 WS 协议，只保留其采集与 WAV 编码：
 *   - getUserMedia（回声消除/降噪/增益），16kHz 单声道
 *   - ScriptProcessor 采集 Float32 → Int16 PCM，松手后统一包 WAV 头
 *   - 输出 base64（不含 data: 前缀），直接作为 recognizeSpeech 的 data 入参
 * 控制器形态沿用 asrClient：{ stop → Promise<{data,format,durationMs}>, abort }。
 */

/** 采样参数：16kHz 单声道 16bit（识别服务侧通用规格） */
const SAMPLE_RATE = 16000

export type RecordResult = { data: string, format: 'wav', durationMs: number }

export type RecordController = {
  /** 松手停止：返回整段 WAV 的 base64 与时长 */
  stop (): Promise<RecordResult>
  /** 异常/取消：立即释放资源，不返回数据 */
  abort (): void
}

export function supportsRecording (): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && !!(window.AudioContext || (window as any).webkitAudioContext)
}

/**
 * 开始一段按住说话录音。onLevel(RMS 0~1) 可用于 UI 声浪动画。
 * 麦克风拒绝/不支持时 start 即抛错（reason: 'mic-denied' | 'unsupported'）。
 */
export async function startRecording (opts: { onLevel?: (rms: number) => void } = {}): Promise<RecordController> {
  if (!supportsRecording()) throw new Error('unsupported')
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    })
  } catch {
    throw new Error('mic-denied')
  }

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE })
  if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* 忽略 */ } }
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  // 零增益节点接 destination：驱动 onaudioprocess 回调又不外放（防回声）
  const mute = ctx.createGain(); mute.gain.value = 0
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination)

  const chunks: Int16Array[] = []
  let stopped = false
  let aborted = false
  let startedAt = Date.now()

  const floatTo16 = (f32: Float32Array) => {
    const out = new Int16Array(f32.length)
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
  }

  proc.onaudioprocess = (e) => {
    if (stopped || aborted) return
    const f32 = e.inputBuffer.getChannelData(0)
    if (opts.onLevel) {
      let sum = 0
      for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i]
      opts.onLevel(Math.sqrt(sum / f32.length))
    }
    chunks.push(floatTo16(f32))
  }

  const teardown = () => {
    try { if (proc) proc.onaudioprocess = null } catch { /* 忽略 */ }
    try { proc?.disconnect() } catch { /* 忽略 */ }
    try { src?.disconnect() } catch { /* 忽略 */ }
    try { mute?.disconnect() } catch { /* 忽略 */ }
    try { stream?.getTracks().forEach(t => t.stop()) } catch { /* 忽略 */ }
    try { ctx?.close() } catch { /* 忽略 */ }
  }

  return {
    stop () {
      if (aborted) return Promise.reject(new Error('aborted'))
      stopped = true
      const durationMs = Math.max(0, Date.now() - startedAt)
      // 尾部一帧可能还在途，下一轮宏任务再打包
      return new Promise<RecordResult>((resolve) => {
        setTimeout(() => {
          teardown()
          const wav = encodeWav(chunks, ctx.sampleRate || SAMPLE_RATE)
          resolve({ data: arrayBufferToBase64(wav.buffer), format: 'wav', durationMs })
        }, 0)
      })
    },
    abort () {
      aborted = true
      stopped = true
      teardown()
    },
  }
}

/** Int16 PCM → 带 44 字节头的 WAV（16bit 单声道） */
function encodeWav (chunks: Int16Array[], sampleRate: number): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const buf = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buf)
  const wstr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  wstr(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)                 // PCM
  view.setUint16(22, 1, true)                 // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)    // 字节率
  view.setUint16(32, 2, true)                 // 块对齐
  view.setUint16(34, 16, true)                // 位深
  wstr(36, 'data')
  view.setUint32(40, total * 2, true)
  let off = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, off += 2) view.setInt16(off, chunk[i], true)
  }
  return new Uint8Array(buf)
}

function arrayBufferToBase64 (buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
