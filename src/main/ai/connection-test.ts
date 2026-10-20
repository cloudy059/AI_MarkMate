import type { LanNode, ProviderConfig, TestResult } from '@shared/types'
import { AiError } from './types'
import { buildAdapterForProvider, } from './resolve'
import { buildAdapterForLanNode } from './lan-balancer'
import { isOllamaProtocol } from './registry'

function errResult(message: string): TestResult {
  return { ok: false, latencyMs: 0, models: [], reply: '', error: message }
}

function describeError(err: unknown): string {
  if (err instanceof AiError) {
    let msg = err.message
    if (err.status === 401) msg += '：API Key 无效或未授权'
    else if (err.status === 403) msg += '：无权限（检查 Key 权限/模型开通）'
    else if (err.status === 404) msg += '：地址或模型不存在（检查 baseUrl / 模型名）'
    else if (err.status === 429) msg += '：请求过于频繁或额度不足'
    if (err.body) msg += ` | ${err.body.slice(0, 200)}`
    return msg
  }
  return err instanceof Error ? err.message : String(err)
}

/** 服务商实时连接测试：模型列表（非致命）+ 最小推理探针 */
export async function testProvider(p: ProviderConfig): Promise<TestResult> {
  if (!p.baseUrl.trim()) return errResult('接口地址为空')
  if (!['ollama', 'lmstudio', 'custom'].includes(p.kind) && !p.apiKey.trim()) {
    return errResult('请先填写 API Key')
  }
  const adapter = buildAdapterForProvider(p)
  let models: string[] = []
  try {
    models = await adapter.listModels()
  } catch {
    // 部分中转未实现 /models，忽略，继续推理探针
  }
  const probeModel = p.chatModel.trim() || models[0] || ''
  if (!probeModel) return errResult('未配置模型，且无法从接口获取模型列表')
  try {
    // 豆包 Seed 默认开思考会拖慢探针，显式禁用；Ollama 同理关闭 think
    const extra = isOllamaProtocol(p.kind)
      ? { think: false }
      : p.kind === 'doubao'
        ? { thinking: { type: 'disabled' } }
        : undefined
    const res = await adapter.chat({
      model: probeModel,
      prompt: '连接测试：请直接回复两个字「正常」，不要输出其他内容。',
      timeoutMs: Math.min(Math.max(p.timeoutMs, 10_000), 30_000),
      temperature: 0,
      extra
    })
    return { ok: true, latencyMs: res.latencyMs, models, reply: res.text.slice(0, 200) }
  } catch (err) {
    return errResult(describeError(err))
  }
}

/** 局域网节点连接测试 */
export async function testLanNode(node: LanNode): Promise<TestResult> {
  if (!node.baseUrl.trim()) return errResult('节点地址为空')
  const adapter = buildAdapterForLanNode(node)
  const t0 = Date.now()
  let models: string[] = []
  try {
    models = await adapter.listModels()
  } catch (err) {
    return errResult(`节点不可达：${describeError(err)}`)
  }
  const probeModel = models[0]
  if (!probeModel) return errResult('节点可达，但未发现任何模型，请先部署模型')
  try {
    const extra = node.kind === 'ollama' ? { think: false } : undefined
    const res = await adapter.chat({
      model: probeModel,
      prompt: '连接测试：请直接回复两个字「正常」。',
      timeoutMs: 30_000,
      temperature: 0,
      extra
    })
    return { ok: true, latencyMs: Date.now() - t0, models, reply: res.text.slice(0, 200) }
  } catch (err) {
    return errResult(`节点可达但推理失败：${describeError(err)}`)
  }
}
