// AI 适配层统一契约

export interface ChatRequest {
  model: string
  system?: string
  prompt: string
  /** 附加图片（data URL），多模态请求 */
  imageDataUrls?: string[]
  maxTokens?: number
  temperature?: number
  timeoutMs: number
  /** 附加请求体参数（深度思考参数等），直接合并进 body */
  extra?: Record<string, unknown>
  /** 要求 JSON 输出（OpenAI response_format / Ollama format） */
  jsonMode?: boolean
}

export interface ChatResponse {
  text: string
  reasoning?: string
  latencyMs: number
  model: string
  raw: unknown
}

export interface AiAdapter {
  protocol: 'openai' | 'ollama'
  baseUrl: string
  apiKey: string
  chat(req: ChatRequest): Promise<ChatResponse>
  listModels(): Promise<string[]>
}

export class AiError extends Error {
  status?: number
  body?: string
  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'AiError'
    this.status = status
    this.body = body
  }
}

/** 规范化 baseUrl：去尾部斜杠 */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
