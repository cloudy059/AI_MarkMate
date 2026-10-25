import { AiError, normalizeBaseUrl, type AiAdapter, type ChatRequest, type ChatResponse } from './types'

/** Ollama 原生 /api/chat 适配器（本机与局域网节点通用） */
export class OllamaAdapter implements AiAdapter {
  protocol = 'ollama' as const
  baseUrl: string
  apiKey: string

  constructor(baseUrl: string, apiKey = '') {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.apiKey = apiKey
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`
    return h
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = Date.now()
    const images = (req.imageDataUrls ?? [])
      .map((u) => u.replace(/^data:[^;]+;base64,/, ''))
      .filter(Boolean)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt, ...(images.length ? { images } : {}) }
      ],
      stream: false,
      ...(req.jsonMode ? { format: 'json' } : {}),
      ...(req.extra ?? {}),
      options: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {})
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), req.timeoutMs)
    let data: any
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      if (!res.ok) throw new AiError(`HTTP ${res.status}`, res.status, text.slice(0, 600))
      data = JSON.parse(text)
    } catch (err) {
      if (err instanceof AiError) throw err
      const msg = err instanceof Error && err.name === 'AbortError' ? `请求超时（${req.timeoutMs}ms）` : `网络错误：${err instanceof Error ? err.message : String(err)}`
      throw new AiError(msg)
    } finally {
      clearTimeout(timer)
    }
    const content: string = data?.message?.content ?? ''
    if (!content) throw new AiError('模型返回内容为空', undefined, JSON.stringify(data).slice(0, 600))
    return {
      text: content,
      reasoning: typeof data?.message?.thinking === 'string' ? data.message.thinking : undefined,
      latencyMs: Date.now() - t0,
      model: req.model,
      raw: data
    }
  }

  /** 流式对话：NDJSON 行解析 message.content 增量 */
  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<string> {
    const images = (req.imageDataUrls ?? [])
      .map((u) => u.replace(/^data:[^;]+;base64,/, ''))
      .filter(Boolean)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt, ...(images.length ? { images } : {}) }
      ],
      stream: true,
      ...(req.extra ?? {})
    }
    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), req.timeoutMs)
    const resetIdle = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), req.timeoutMs)
    }
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof AiError) throw err
      throw new AiError(err instanceof Error && err.name === 'AbortError' ? `请求超时（${req.timeoutMs}ms）` : `网络错误：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      clearTimeout(timer)
      const text = await res.text().catch(() => '')
      throw new AiError(`HTTP ${res.status}`, res.status, text.slice(0, 600))
    }
    const reader = res.body?.getReader()
    if (!reader) {
      clearTimeout(timer)
      throw new AiError('响应无内容流')
    }
    const dec = new TextDecoder()
    let buf = ''
    let full = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        resetIdle()
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const s = line.trim()
          if (!s) continue
          try {
            const j = JSON.parse(s) as { message?: { content?: unknown }; done?: boolean }
            const delta = j.message?.content
            if (typeof delta === 'string' && delta) {
              full += delta
              onDelta(delta)
            }
          } catch {
            /* 跳过不完整行 */
          }
        }
      }
    } catch (err) {
      if (full) return full
      throw new AiError(`流式读取失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
    if (!full) throw new AiError('模型返回内容为空')
    return full
  }

  async listModels(): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal })
      if (!res.ok) throw new AiError(`HTTP ${res.status}`, res.status)
      const data = (await res.json()) as any
      const arr = data?.models
      if (!Array.isArray(arr)) return []
      return arr.map((m: any) => String(m?.name ?? '')).filter(Boolean)
    } catch (err) {
      if (err instanceof AiError) throw err
      throw new AiError(`网络错误：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}
