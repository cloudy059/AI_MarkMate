import type { ProviderConfig, ProviderKind, ProviderRef } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { VENDOR_PRESETS, isOllamaProtocol } from './registry'
import { OllamaAdapter } from './ollama-adapter'
import { OpenAiAdapter } from './openai-adapter'
import { buildAdapterForLanNode, lanBalancer } from './lan-balancer'
import type { AiAdapter } from './types'

export type ModelPurpose = 'chat' | 'vision' | 'ocr'

export class ResolveError extends Error {}

export interface ResolvedTarget {
  name: string
  kindLabel: string
  protocol: 'openai' | 'ollama'
  baseUrl: string
  apiKey: string
  timeoutMs: number
  model: string
  adapter: AiAdapter
  providerKind?: ProviderKind
}

export function buildAdapterForProvider(p: ProviderConfig): AiAdapter {
  return isOllamaProtocol(p.kind)
    ? new OllamaAdapter(p.baseUrl, p.apiKey)
    : new OpenAiAdapter(p.baseUrl, p.apiKey)
}

const PURPOSE_LABEL: Record<ModelPurpose, string> = { chat: '文本评分', vision: '多模态直评', ocr: '识图OCR' }

function defaultModelFor(p: ProviderConfig, purpose: ModelPurpose): string {
  if (purpose === 'chat') return p.chatModel
  if (purpose === 'ocr') return p.ocrModel || p.visionModel
  return p.visionModel || p.chatModel
}

/** 将工作流中的 ProviderRef 解析为具体可调用的适配器与模型 */
export function resolveProviderRef(ref: ProviderRef | null | undefined, purpose: ModelPurpose): ResolvedTarget {
  if (!ref || (!ref.providerId && !ref.lanNodeId && ref.source !== 'lan')) {
    throw new ResolveError('该环节尚未配置模型来源')
  }
  const cfg = configStore.get()

  if (ref.source === 'lan') {
    const node = lanBalancer.pickNode(ref.lanNodeId)
    if (!node) throw new ResolveError('局域网节点不可用：请检查节点是否已添加、启用且健康检查通过')
    if (!ref.model?.trim()) throw new ResolveError('局域网节点需要先在该环节选择具体模型')
    return {
      name: node.name,
      kindLabel: `局域网·${node.kind}`,
      protocol: node.kind === 'ollama' ? 'ollama' : 'openai',
      baseUrl: node.baseUrl,
      apiKey: node.apiKey,
      timeoutMs: 120_000,
      model: ref.model.trim(),
      adapter: buildAdapterForLanNode(node),
      providerKind: node.kind
    }
  }

  const p = cfg.providers.find((x) => x.id === ref.providerId)
  if (!p) throw new ResolveError('未找到对应的服务商配置，请重新选择')
  if (!p.enabled) throw new ResolveError(`服务商「${p.name}」未启用，请到「AI服务商」页开启`)
  if (!['ollama', 'lmstudio', 'custom'].includes(p.kind) && !p.apiKey.trim()) {
    throw new ResolveError(`服务商「${p.name}」未填写 API Key`)
  }
  const model = ref.model?.trim() || defaultModelFor(p, purpose)
  if (!model) throw new ResolveError(`服务商「${p.name}」未配置${PURPOSE_LABEL[purpose]}模型`)
  return {
    name: p.name,
    kindLabel: VENDOR_PRESETS[p.kind]?.name ?? p.kind,
    protocol: isOllamaProtocol(p.kind) ? 'ollama' : 'openai',
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    timeoutMs: p.timeoutMs > 0 ? p.timeoutMs : 120_000,
    model,
    adapter: buildAdapterForProvider(p),
    providerKind: p.kind
  }
}
