// 世界网关（千问）识别引擎：把「识别这件事」交给宿主的 capabilityHub。
//
// 这一层刻意不做的事：
//   - 不管协议、不管凭据、不管模型名——那些属于世界网关（capability-hub）；
//   - 不写文件、不做缓存与审计——那是 service 的活，这里只吃规范 wav、吐文本；
//   - 不在 status() 里发网络请求：面板每秒轮询，不能每次都打一次上游。
//     status 只答「网关此刻能不能识别」，所以拿网关给的快照，异步刷新、带 TTL。
//
// 为什么走进程内而不是 HTTP：服务端请求没有浏览器会话，打网关自己的 HTTP 面必然 401。
import { readFileSync } from 'node:fs'
import { AsrError } from './errors.mjs'

const ENGINE_ID = 'gateway'
/** 快照多久算过期。面板轮询间隔是秒级，3 秒足以跟上「刚填了 key」这类变化。 */
const SNAPSHOT_TTL_MS = 3000

/**
 * @param options.getHub - 取 `capabilityHub` 服务；没挂上就返回 undefined
 * @param options.logger - 可选日志
 * @param options.readFile - 测试替身
 */
export function createGatewayEngine({ getHub, logger = null, readFile = readFileSync }) {
  const info = {
    id: ENGINE_ID,
    name: '世界网关（千问）',
    location: 'cloud',
    // 只承诺「自动」：语言提示还没验证过能透传给上游，就不写 zh/en 假装支持。
    languages: ['auto'],
    about: {
      summary: '把录音交给宿主的「世界网关」，由它转给千问识别；和语音合成共用一把 key。',
      pros: ['不用下载模型', '换模型在网关面板里改，这里不用重配', '和语音合成共用同一份凭据'],
      cons: ['必须联网', '按音频时长计费（阿里云收取，与本插件无关）', '实测偏慢：4.4 秒音频约 21 秒'],
    },
  }

  const hub = () => (typeof getHub === 'function' ? getHub() : undefined)

  let snapshot = { ready: false, error: '正在向世界网关确认…', model: null }
  let fetchedAt = 0
  let refreshing = false

  /** 异步刷新快照；并发调用合流。失败不抛——面板该看到的是「没就绪 + 原因」。 */
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const service = hub()
      if (!service || typeof service.status !== 'function') {
        snapshot = { ready: false, error: '世界网关没挂载（dsh-capability-hub 未启用或未重启）', model: null }
        return
      }
      const health = await service.status('asr')
      snapshot = health?.ready === true
        ? { ready: true, error: null, model: health.model ?? null }
        : { ready: false, error: String(health?.error ?? '世界网关的 asr 插槽没启用'), model: health?.model ?? null }
    } catch (error) {
      snapshot = { ready: false, error: String(error?.message ?? error), model: null }
    } finally {
      fetchedAt = Date.now()
      refreshing = false
    }
  }

  function status() {
    if (Date.now() - fetchedAt > SNAPSHOT_TTL_MS) void refresh()
    return {
      id: info.id,
      name: info.name,
      location: info.location,
      languages: info.languages,
      ready: snapshot.ready === true,
      preparing: false,
      model: snapshot.model ? { name: snapshot.model } : null,
      worker: null,
      transfer: null,
      error: snapshot.error ?? null,
    }
  }

  /** 网关是别人的进程，这边没有要准备的资产。显式提供，面板会显示「无需准备」而不是报错。 */
  async function prepare() {
    await refresh()
    if (!snapshot.ready) throw new AsrError(String(snapshot.error ?? '世界网关的 asr 插槽没准备好'), { code: 'ASR_GATEWAY_NOT_READY', status: 503 })
    return { ok: true, ready: true }
  }

  async function transcribe({ wavPath } = {}) {
    const service = hub()
    if (!service || typeof service.transcribe !== 'function') {
      throw new AsrError('世界网关不可用', {
        code: 'ASR_GATEWAY_UNAVAILABLE',
        hint: '确认 dsh-capability-hub 已安装并在 profile 中启用，然后重启 DSH',
        status: 503,
      })
    }
    let bytes
    try {
      bytes = readFile(wavPath)
    } catch (error) {
      throw new AsrError(`读不到临时音频：${error?.message ?? error}`, { code: 'ASR_AUDIO_INVALID' })
    }
    const started = Date.now()
    let result
    try {
      // 规范音频固定是 16kHz/16bit/单声道（见 audio.mjs 的 CANONICAL_RATE），直接照实告诉上游。
      result = await service.transcribe('asr', { audio: bytes, format: 'wav', sampleRate: 16000 })
    } catch (error) {
      const message = String(error?.message ?? error)
      logger?.warn?.(`世界网关识别失败：${message}`)
      throw new AsrError(message, {
        code: 'ASR_GATEWAY_FAILED',
        hint: '检查网关面板里 asr 插槽是否启用、模型与凭据是否填对',
        status: typeof error?.status === 'number' ? error.status : 502,
      })
    }
    const inferenceSeconds = (Date.now() - started) / 1000
    const text = String(result?.text ?? '')
    return {
      text,
      audioSeconds: Number(result?.audioSeconds ?? 0) || 0,
      inferenceSeconds,
      engine: info.id,
      model: result?.model ?? null,
    }
  }

  return { info, status, prepare, transcribe, cancelPrepare: () => {}, dispose: async () => {} }
}
