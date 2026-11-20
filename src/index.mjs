// 插件入口：装配状态目录 → 引擎 → 服务 → 两个 HTTP 面。
//
// 这里只做「接线」，不含策略：所有判断都在 service 与引擎里，
// 这样测试可以绕过 HTTP 直接跑服务，面板与内部调用也天然行为一致。
import { join } from 'node:path'
import { prepareStateDir, projectHome, resolveComponentPath } from '../../_shared/paths.mjs'
import { registerComponentInternal } from '../../_shared/ipc.mjs'
import { createConfigStore } from './store.mjs'
import { createModelStore } from './model-store.mjs'
import { createEngineRegistry } from './engine-registry.mjs'
import { createSensevoiceEngine } from './engine-sensevoice.mjs'
import { createGatewayEngine } from './engine-gateway.mjs'
import { createAsrService } from './service.mjs'
import { registerAsrHttp } from './http.mjs'
import { createInternalHandler } from './internal.mjs'

export const name = 'dsh-local-asr'
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const env = process.env
  const home = projectHome(env)
  const stateDir = prepareStateDir(resolveComponentPath(env, 'DSH_ASR_STATE_DIR', join(home, 'asr'), { label: '语音识别状态目录' }), '语音识别状态目录')
  const logger = ctx.logger ?? null

  const configStore = createConfigStore(stateDir)
  const modelStore = createModelStore(stateDir, { getOrigins: () => configStore.get().sensevoice.modelSources, logger })
  const engines = createEngineRegistry()
  const engine = createSensevoiceEngine({ stateDir, modelStore, getConfig: () => configStore.get(), logger })
  const unregister = engines.register(engine)

  // 世界网关（千问）是第二个引擎：识别交给宿主的 capabilityHub，这边不碰协议与凭据。
  // 用 inject 订阅而不是 ctx.get：服务由另一个插件的 apply 提供，可能比这里晚就绪。
  let hub
  const disposeHub = ctx.inject(['capabilityHub'], child => {
    hub = child.capabilityHub ?? undefined
    return () => { hub = undefined }
  })
  const gatewayEngine = createGatewayEngine({ getHub: () => hub, logger })
  const unregisterGateway = engines.register(gatewayEngine)

  const { service } = createAsrService({ stateDir, configStore, engines, engine, logger })

  const disposeHttp = registerAsrHttp(ctx, service, { logger })
  let disposeInternal
  try {
    disposeInternal = registerComponentInternal(ctx, { home, name: 'asr', handle: createInternalHandler(service, { logger }) })
  } catch (error) {
    disposeHttp()
    throw error
  }
  logger?.info?.(`语音识别已挂载（引擎 ${configStore.get().engine}，状态目录 ${stateDir}）`)

  ctx.effect(() => async () => {
    disposeInternal(); disposeHttp(); disposeHub(); unregisterGateway(); unregister()
    await service.dispose()
  })
}

export default { name, inject, apply }
