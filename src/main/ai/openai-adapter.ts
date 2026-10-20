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
    const userContent: unknown = req.imageDataUrls?.length
      ? [
          { type: 'text', text: req.prompt },
          ...req.imageDataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
        ]
      : req.prompt
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: userContent }
    ]
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
