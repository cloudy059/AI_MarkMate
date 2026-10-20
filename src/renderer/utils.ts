// ============================================================
// 渲染进程通用工具
// ============================================================

import { useEffect, useState } from 'react'

let counter = 0

/** 生成短 id（渲染进程用，不依赖主进程） */
export function genId(prefix = 'r'): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** IPC 统一错误包装：主进程 safe() 包装的处理器失败时返回 { __error }，这里还原为异常 */
export function unwrap<T>(r: T | { __error: string }): T {
  if (r && typeof r === 'object' && '__error' in (r as Record<string, unknown>)) {
    throw new Error(String((r as { __error: string }).__error))
  }
  return r as T
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 简单防抖 */
export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
}

// ---------- 厂商展示信息（与主进程 registry 保持一致的渲染层副本） ----------
export interface VendorInfo {
  name: string
  hint: string
  fixedUrl: boolean
  local: boolean
  hasVision: boolean
  /** 服务商 API 控制台 / 密钥管理页面地址（本机服务与自定义中转无） */
  consoleUrl?: string
}

export const VENDOR_INFO: Record<string, VendorInfo> = {
  qwen: {
    name: '通义千问',
    hint: '阿里云百炼 DashScope，OpenAI 兼容模式；OCR 推荐 qwen-vl-ocr',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key'
  },
  zhipu: {
    name: '智谱AI',
    hint: '智谱开放平台，OpenAI 兼容；OCR 推荐 glm-4v-ocr',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://open.bigmodel.cn/apikey/platform'
  },
  doubao: {
    name: '豆包（火山方舟）',
    hint: '火山方舟 Ark v3，OpenAI 兼容；模型名可填推理接入点 ID(ep-xxx)',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey'
  },
  moonshot: {
    name: 'Kimi（月之暗面）',
    hint: '月之暗面开放平台，OpenAI 兼容',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  deepseek: {
    name: 'DeepSeek',
    hint: 'DeepSeek 开放平台；暂无公开视觉模型',
    fixedUrl: true,
    local: false,
    hasVision: false,
    consoleUrl: 'https://platform.deepseek.com/api_keys'
  },
  openai: {
    name: 'OpenAI',
    hint: '官方 API；也可在「自定义中转」配置代理地址',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    name: 'Gemini',
    hint: 'Google AI Studio OpenAI 兼容端点；视觉能力原生',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://aistudio.google.com/apikey'
  },
  xfyun: {
    name: '讯飞星火',
    hint: '讯飞星火开放端点，OpenAI 兼容；APIPassword 作为密钥',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://console.xfyun.cn/'
  },
  xiaomi: {
    name: '小米AI',
    hint: '小米大模型开放平台；地址以官方文档为准，可修改',
    fixedUrl: false,
    local: false,
    hasVision: false
  },
  minimax: {
    name: 'MiniMax',
    hint: 'MiniMax 开放平台，OpenAI 兼容',
    fixedUrl: true,
    local: false,
    hasVision: true,
    consoleUrl: 'https://platform.minimaxi.com/'
  },
  custom: {
    name: '自定义中转接口',
    hint: '任意 OpenAI 协议格式的第三方中转：填完整地址（含 /v1）、密钥与模型名',
    fixedUrl: false,
    local: false,
    hasVision: true
  },
  ollama: {
    name: 'Ollama（本机）',
    hint: '本机 Ollama 服务，无需密钥；视觉模型建议 qwen2.5vl / llama3.2-vision',
    fixedUrl: false,
    local: true,
    hasVision: true
  },
  lmstudio: {
    name: 'LM Studio（本机）',
    hint: '本机 LM Studio 本地服务器，无需密钥；地址默认 http://127.0.0.1:1234/v1',
    fixedUrl: false,
    local: true,
    hasVision: true
  }
}

export const isLocalKind = (k: string): boolean => VENDOR_INFO[k]?.local ?? false

/** 窄容器检测：视口宽度小于阈值时返回 true（侧边栏设置视图用），随窗口缩放实时更新 */
export function useNarrow(px = 520): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => window.innerWidth < px)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < px)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [px])
  return narrow
}
