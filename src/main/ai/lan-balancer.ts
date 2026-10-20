import type { LanNode } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { OllamaAdapter } from './ollama-adapter'
import { OpenAiAdapter } from './openai-adapter'
import type { AiAdapter } from './types'

export function buildAdapterForLanNode(node: LanNode): AiAdapter {
  if (node.kind === 'ollama') return new OllamaAdapter(node.baseUrl, node.apiKey)
  return new OpenAiAdapter(node.baseUrl, node.apiKey)
}

async function probeNode(node: LanNode): Promise<LanNode> {
  const t0 = Date.now()
  try {
    const adapter = buildAdapterForLanNode(node)
    const models = await adapter.listModels()
    return {
      ...node,
      health: { ok: true, rttMs: Date.now() - t0, checkedAt: Date.now(), models }
    }
  } catch {
    return {
      ...node,
      health: { ok: false, rttMs: Date.now() - t0, checkedAt: Date.now(), models: [] }
    }
  }
}

/** 局域网多节点：周期健康检查 + 轮询分发 */
class LanBalancer {
  private timer: NodeJS.Timeout | null = null
  private rrIndex = 0

  start(): void {
    if (this.timer) return
    this.checkAll().catch(() => undefined)
    this.timer = setInterval(() => this.checkAll().catch(() => undefined), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 轮询选择一个健康节点；指定 id 时直取该节点 */
  pickNode(lanNodeId?: string): LanNode | null {
    const nodes = configStore.get().lanNodes.filter((n) => n.enabled)
    if (lanNodeId) {
      const n = nodes.find((x) => x.id === lanNodeId)
      return n && n.health.ok ? n : null
    }
    const ok = nodes.filter((n) => n.health.ok)
    if (!ok.length) return null
    return ok[this.rrIndex++ % ok.length]
  }

  async checkAll(): Promise<LanNode[]> {
    const cfg = configStore.get()
    if (!cfg.lanNodes.length) return []
    const results = await Promise.all(cfg.lanNodes.map(probeNode))
    configStore.patch({ lanNodes: results })
    return results
  }
}

export const lanBalancer = new LanBalancer()
