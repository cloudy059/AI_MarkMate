import type { AppConfig, ProviderConfig, ProviderKind } from '@shared/types'
import { CURRENT_CONFIG_VERSION as CFG_VER } from '@shared/types'
import { genId } from '@main/utils'

// ============================================================
// 厂商注册表：默认 baseUrl / 默认模型 / 深度思考参数映射
// ============================================================

/** 深度思考参数映射策略 */
export type ThinkingStrategy =
  | 'reasoning_effort' // body.reasoning_effort = low|medium|high（OpenAI 系 / Gemini / LM Studio / 中转）
  | 'qwen_thinking' // body.enable_thinking + thinking_budget（通义 Qwen3）
  | 'zhipu_thinking' // body.thinking.type = enabled（智谱）
  | 'doubao_thinking' // body.thinking = { type: 'enabled' }（豆包 Seed）
  | 'ollama_think' // body.think = "low|medium|high"（Ollama）
  | 'reasoner_switch' // 切换到推理模型（DeepSeek / 讯飞 / Kimi）
  | 'prompt_only' // 无原生参数，提示词注入思考要求（小米 / MiniMax 等）

export interface VendorPreset {
  kind: ProviderKind
  name: string
  baseUrl: string
  chatModel: string
  visionModel: string
  ocrModel: string
  /** API 协议 */
  protocol: 'openai' | 'ollama'
  thinking: ThinkingStrategy
  /** API 地址是否可自定义（云端厂商均固定官方地址，custom 可改） */
  fixedUrl: boolean
  hint: string
}

export const VENDOR_PRESETS: Record<ProviderKind, VendorPreset> = {
  qwen: {
    kind: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-plus',
    visionModel: 'qwen3-vl-plus',
    ocrModel: 'qwen-vl-ocr',
    protocol: 'openai',
    thinking: 'qwen_thinking',
    fixedUrl: true,
    hint: '阿里云百炼 DashScope，OpenAI 兼容模式；OCR 推荐 qwen-vl-ocr'
  },
  zhipu: {
    kind: 'zhipu',
    name: '智谱AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatModel: 'glm-4-flash',
    visionModel: 'glm-4v-flash',
    ocrModel: 'glm-4v-ocr',
    protocol: 'openai',
    thinking: 'zhipu_thinking',
    fixedUrl: true,
    hint: '智谱开放平台，OpenAI 兼容；OCR 推荐 glm-4v-ocr'
  },
  doubao: {
    kind: 'doubao',
    name: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatModel: 'doubao-seed-2-0-lite-260428',
    visionModel: 'doubao-seed-2-0-lite-260428',
    ocrModel: 'doubao-seed-2-0-lite-260428',
    protocol: 'openai',
    thinking: 'doubao_thinking',
    fixedUrl: true,
    hint: '火山方舟 Ark v3，OpenAI 兼容；模型名可填推理接入点 ID(ep-xxx)'
  },
  moonshot: {
    kind: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    chatModel: 'kimi-latest',
    visionModel: 'moonshot-v1-8k-vision-preview',
    ocrModel: 'moonshot-v1-8k-vision-preview',
    protocol: 'openai',
    thinking: 'reasoner_switch',
    fixedUrl: true,
    hint: '月之暗面开放平台，OpenAI 兼容'
  },
  deepseek: {
    kind: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-chat',
    visionModel: '',
    ocrModel: '',
    protocol: 'openai',
    thinking: 'reasoner_switch',
    fixedUrl: true,
    hint: 'DeepSeek 开放平台；暂无公开视觉模型'
  },
  openai: {
    kind: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModel: 'gpt-4.1-mini',
    visionModel: 'gpt-4.1-mini',
    ocrModel: 'gpt-4.1-mini',
    protocol: 'openai',
    thinking: 'reasoning_effort',
    fixedUrl: true,
    hint: '官方 API；也可在「自定义中转」配置代理地址'
  },
  gemini: {
    kind: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    chatModel: 'gemini-2.5-flash',
    visionModel: 'gemini-2.5-flash',
    ocrModel: 'gemini-2.5-flash',
    protocol: 'openai',
    thinking: 'reasoning_effort',
    fixedUrl: true,
    hint: 'Google AI Studio OpenAI 兼容端点；视觉能力原生'
  },
  xfyun: {
    kind: 'xfyun',
    name: '讯飞星火',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    chatModel: 'lite',
    visionModel: 'x1-vision',
    ocrModel: 'x1-vision',
    protocol: 'openai',
    thinking: 'reasoner_switch',
    fixedUrl: true,
    hint: '讯飞星火开放端点，OpenAI 兼容；APIPassword 作为密钥'
  },
  xiaomi: {
    kind: 'xiaomi',
    name: '小米AI',
    baseUrl: 'https://api.mi-omo.cn/v1',
    chatModel: 'mimo-7b',
    visionModel: '',
    ocrModel: '',
    protocol: 'openai',
    thinking: 'prompt_only',
    fixedUrl: false,
    hint: '小米大模型开放平台；地址以官方文档为准，可修改'
  },
  minimax: {
    kind: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    chatModel: 'MiniMax-M1',
    visionModel: 'MiniMax-VL-01',
    ocrModel: 'MiniMax-VL-01',
    protocol: 'openai',
    thinking: 'prompt_only',
    fixedUrl: true,
    hint: 'MiniMax 开放平台，OpenAI 兼容'
  },
  custom: {
    kind: 'custom',
    name: '自定义中转接口',
    baseUrl: '',
    chatModel: '',
    visionModel: '',
    ocrModel: '',
    protocol: 'openai',
    thinking: 'reasoning_effort',
    fixedUrl: false,
    hint: '任意 OpenAI 协议格式的第三方中转：填完整地址（含 /v1）、密钥与模型名'
  },
  ollama: {
    kind: 'ollama',
    name: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434',
    chatModel: 'qwen3:8b',
    visionModel: 'qwen2.5vl:7b',
    ocrModel: 'qwen2.5vl:7b',
    protocol: 'ollama',
    thinking: 'ollama_think',
    fixedUrl: false,
    hint: '本机 Ollama 服务，无需密钥；视觉模型建议 qwen2.5vl / llama3.2-vision'
  },
  lmstudio: {
    kind: 'lmstudio',
    name: 'LM Studio（本机）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    chatModel: '',
    visionModel: '',
    ocrModel: '',
    protocol: 'openai',
    thinking: 'reasoning_effort',
    fixedUrl: false,
    hint: '本机 LM Studio 本地服务器，无需密钥；地址默认 http://127.0.0.1:1234/v1'
  }
}

/** 本机本地服务商 kind（用于 UI 分组与流程判断） */
export const LOCAL_KINDS: ProviderKind[] = ['ollama', 'lmstudio']
export const isLocalKind = (k: ProviderKind): boolean => LOCAL_KINDS.includes(k)
export const isOllamaProtocol = (k: ProviderKind): boolean =>
  VENDOR_PRESETS[k]?.protocol === 'ollama'

/**
 * 深度思考功能已移除：默认不附加任何思考参数。
 * 仅豆包 Seed 系列需显式禁用其默认开启的思考模式（否则每题评分极慢甚至超时）。
 */
export function buildThinkingParams(
  kind: ProviderKind
): { extra: Record<string, unknown>; modelOverride: string | null; note: string } {
  if ((VENDOR_PRESETS[kind]?.thinking ?? 'prompt_only') === 'doubao_thinking') {
    return { extra: { thinking: { type: 'disabled' } }, modelOverride: null, note: '已禁用豆包默认深度思考' }
  }
  return { extra: {}, modelOverride: null, note: '' }
}

function makeProvider(kind: ProviderKind): ProviderConfig {
  const p = VENDOR_PRESETS[kind]
  return {
    id: genId('prov'),
    name: p.name,
    kind,
    baseUrl: p.baseUrl,
    apiKey: '',
    chatModel: p.chatModel,
    visionModel: p.visionModel,
    ocrModel: p.ocrModel,
    timeoutMs: 120000,
    enabled: false
  }
}

/** 生成全新默认配置：全部云端厂商 + 本机 Ollama/LM Studio 预置项（默认停用，填 Key 即用） */
export function defaultConfig(): AppConfig {
  const cloudKinds: ProviderKind[] = [
    'qwen', 'zhipu', 'doubao', 'moonshot', 'deepseek', 'openai', 'gemini', 'xfyun', 'xiaomi', 'minimax'
  ]
  const providers: ProviderConfig[] = [
    ...cloudKinds.map(makeProvider),
    makeProvider('custom'),
    makeProvider('ollama'),
    makeProvider('lmstudio')
  ]
  const ollama = providers.find((p) => p.kind === 'ollama')!
  const lmstudio = providers.find((p) => p.kind === 'lmstudio')!
  return {
    version: CFG_VER,
    providers,
    lanNodes: [],
    workflow: {
      mode: 'A',
      roles: {
        grader: { source: 'cloud', providerId: providers[0].id },
        grader2: null,
        ocr: { source: 'local', providerId: ollama.id }
      },
      gradingMode: 'trial',
      doubleThreshold: 2,
      deepThink: { enabled: false, level: 2 },
      nextDelayMs: 2000,
      plannedCount: 0,
      rulesPrompt: '你是一位严谨且富有经验的阅卷老师。请依据评分标准对学生作答进行评分，做到客观、一致、可解释。'
    },
    regions: {},
    subQuestions: [],
    scoreConfig: { total: 10, min: 0, max: 10, step: 1 },
    scoringStandards: Array.from({ length: 10 }, () => null),
    activeStandardIndex: 0,
    presets: [],
    settings: {
      hotkeyToggle: 'Control+Shift+G',
      sidebarHidden: false,
      sidebarPos: null,
      theme: 'light',
      uiLanguage: 'zh-CN'
    },
    onboardingDone: false
  }
}
