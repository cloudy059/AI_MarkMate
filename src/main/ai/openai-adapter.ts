import { AiError, normalizeBaseUrl, type AiAdapter, type ChatRequest, type ChatResponse } from './types'

/** 统一 OpenAI 协议适配器：覆盖通义/智谱/豆包/Kimi/DeepSeek/OpenAI/Gemini/星火/小米/MiniMax/自定义中转/LM Studio */
export class OpenAiAdapter implements AiAdapter {
  protocol = 'openai' as const
  baseUrl: string
  apiKey: string

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.apiKey = apiKey.trim()
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`
    return h
  }

  private async fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    let bodyText = ''
    try {
      res = await fetch(url, { ...init, signal: controller.signal })
      bodyText = await res.text()
    } catch (err) {
      const msg = err instanceof Error && err.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : `网络错误：${err instanceof Error ? err.message : String(err)}`
      throw new AiError(msg)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new AiError(`HTTP ${res.status}`, res.status, bodyText.slice(0, 600))
    try {
      return JSON.parse(bodyText)
    } catch {
      throw new AiError('响应不是有效 JSON', res.status, bodyText.slice(0, 600))
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = Date.now()
    const messages = this.buildMessages(req)
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(req.extra ?? {})
    }
    let data: any
    try {
      data = await this.fetchJson(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body)
      }, req.timeoutMs)
    } catch (err) {
      // 部分中转/模型不支持 response_format，自动降级重试一次
      if (req.jsonMode && err instanceof AiError && err.body && /response_format|json_object/i.test(err.body)) {
        delete body.response_format
        data = await this.fetchJson(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body)
        }, req.timeoutMs)
      } else throw err
    }
    const choice = data?.choices?.[0]
    const msg = choice?.message
    const text: string = (typeof msg?.content === 'string' ? msg.content : '') || ''
    if (!text) throw new AiError('模型返回内容为空', undefined, JSON.stringify(data).slice(0, 600))
    return {
      text,
      reasoning: typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : undefined,
      latencyMs: Date.now() - t0,
      model: req.model,
      raw: data
    }
  }

  /** 构造 OpenAI 协议 messages 数组 */
  private buildMessages(req: ChatRequest): unknown[] {
    const userContent: unknown = req.imageDataUrls?.length
      ? [
          { type: 'text', text: req.prompt },
          ...req.imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
        ]
      : req.prompt
    return [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: userContent }
    ]
  }

  /** 流式对话：SSE data: 行增量解析 choices[0].delta.content */
  async chatStream(req: ChatRequest, onDelta: (delta: string) => void): Promise<string> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.buildMessages(req),
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.extra ?? {})
    }
    const controller = new AbortController()
    // 空闲超时：每收到数据即重置（长分析不受总时长限制，只防卡死）
    let timer = setTimeout(() => controller.abort(), req.timeoutMs)
    const resetIdle = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), req.timeoutMs)
    }
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
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
          if (!s.startsWith('data:')) continue
          const payload = s.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: unknown } }> }
            const delta = j.choices?.[0]?.delta?.content
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
      if (full) return full // 中断前已有内容：按已收到的返回
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
    const data = await this.fetchJson(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers()
    }, 15000)
    const arr = (data as any)?.data
    if (!Array.isArray(arr)) return []
    return arr.map((m: any) => String(m?.id ?? m?.name ?? '')).filter(Boolean)
  }
}
