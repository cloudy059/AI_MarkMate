import type { ScoreConfig, SubQuestion } from '@shared/types'

export interface ParseResult {
  ok: boolean
  score?: number
  /** 分小题模式：按 subQs 顺序的归一化分数 */
  scores?: number[]
  reason?: string
  /** 分小题模式：按 subQs 顺序的各小题评分依据（该小题无理由时为 undefined） */
  subReasons?: (string | undefined)[]
  error?: string
  /** 归一化前的原始提取值 */
  rawValue?: number
}

/** 提取第一个平衡的 {...} JSON 子串 */
function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  const stack: number[] = []
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') stack.push(i)
    else if (ch === '}' && stack.length) {
      const start = stack.pop()!
      if (stack.length === 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)))
        } catch {
          /* 非法 JSON 跳过 */
        }
      }
    }
  }
  return out
}

function pickScoreFrom(obj: Record<string, unknown>): number | undefined {
  const keys = ['score', 'Score', 'SCORE', '得分', '分数', '评分', 'final_score', 'finalScore', 'total']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const m = v.match(/-?\d+(?:\.\d+)?/)
      if (m) return parseFloat(m[0])
    }
  }
  return undefined
}

function pickReasonFrom(obj: Record<string, unknown>): string | undefined {
  const keys = ['reason', 'Reason', '理由', '依据', '评分依据', 'rationale', 'explanation']
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** 正则兜底：从自由文本中找分数 */
function regexFallback(text: string): number | undefined {
  const patterns = [
    /(?:得分|分数|评分|score)\s*[:：]?\s*[*$\s]*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*分(?!\d)/,
    /给\s*(\d+(?:\.\d+)?)\s*分/
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return parseFloat(m[1])
  }
  return undefined
}

/** 将分数归一化：贴合步长并夹取到 [min, max] */
function normalizeScore(v: number, cfg: ScoreConfig): number {
  const min = Math.min(cfg.min, cfg.max)
  const max = Math.max(cfg.min, cfg.max)
  const step = cfg.step > 0 ? cfg.step : 1
  let snapped = min + Math.round((v - min) / step) * step
  snapped = Math.max(min, Math.min(max, snapped))
  // 消除浮点误差（如 0.30000000000000004）：保留位数取步长自身的小数位数
  // 注意不能用 ceil(-log10(step))：step=1.5 时会算出 0 位，把 4.5 舍成 5
  const decimals = Math.min((String(step).split('.')[1] ?? '').length, 4)
  return Number(snapped.toFixed(decimals))
}

/** 对外：按主/小题配置归一化人工给分（小题步长统一跟随全局步长，防止小题自动均分产生的 0.5 步长与教师设定冲突） */
export function normalizeScoreForConfig(v: number, cfg: ScoreConfig, subQ: SubQuestion | null): number {
  const effective: ScoreConfig = subQ
    ? { total: subQ.maxScore, min: subQ.minScore, max: subQ.maxScore, step: cfg.step }
    : cfg
  return normalizeScore(v, effective)
}

/** 对外：教师权威输入（纠错/人工给分/仲裁）只夹取到 [min, max]，不做步长量化——教师明确给出的分数不应被静默改写 */
export function clampScoreForConfig(v: number, cfg: ScoreConfig, subQ: SubQuestion | null): number {
  const min = subQ ? Math.min(subQ.minScore, subQ.maxScore) : Math.min(cfg.min, cfg.max)
  const max = subQ ? Math.max(subQ.minScore, subQ.maxScore) : Math.max(cfg.min, cfg.max)
  const clamped = Math.max(min, Math.min(max, v))
  return Number(clamped.toFixed(4))
}

/**
 * 三级分数解析：整串 JSON → 平衡 {...} 子串 → 正则兜底
 */
export function parseScore(raw: string, cfg: ScoreConfig, subQ: SubQuestion | null): ParseResult {
  const effective: ScoreConfig = subQ
    ? { total: subQ.maxScore, min: subQ.minScore, max: subQ.maxScore, step: cfg.step }
    : cfg
  const text = raw.trim()

  // 1) 整串 / 子串 JSON
  const objs = extractJsonObjects(text)
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const score = pickScoreFrom(o as Record<string, unknown>)
      if (score !== undefined) {
        const norm = normalizeScore(score, effective)
        return {
          ok: true,
          score: norm,
          rawValue: score,
          reason: pickReasonFrom(o as Record<string, unknown>) ?? `模型原始给分 ${score}，已按步长归一化为 ${norm}`
        }
      }
    }
  }

  // 2) 正则兜底
  const byRegex = regexFallback(text)
  if (byRegex !== undefined) {
    const norm = normalizeScore(byRegex, effective)
    return {
      ok: true,
      score: norm,
      rawValue: byRegex,
      reason: `正则解析得原始分 ${byRegex}，已归一化为 ${norm}`
    }
  }

  return {
    ok: false,
    error: '无法从模型输出中解析出分数，请重试或人工给分',
    reason: text.slice(0, 300)
  }
}

/** 从 {"scores": [...]} 的数组元素中提取单个小题分 */
function pickSubScore(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    const n = pickScoreFrom(rec)
    if (n !== undefined) return n
  }
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(?:\.\d+)?/)
    if (m) return parseFloat(m[0])
  }
  return undefined
}

/** 提取 scores 数组元素的名称（用于按小题名对位） */
function pickSubName(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const k of ['name', 'Name', '小题', '名称']) {
      const s = rec[k]
      if (typeof s === 'string' && s.trim()) return s.trim()
    }
  }
  return undefined
}

/** 提取 scores 数组元素的评分依据 */
function pickSubReason(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>
    for (const k of ['reason', 'Reason', '理由', '依据', '评分依据']) {
      const s = rec[k]
      if (typeof s === 'string' && s.trim()) return s.trim()
    }
  }
  return undefined
}

/**
 * 分小题模式解析：期望 {"scores":[{"name":"小题1","score":4}, ...]} 或 {"scores":[4,3,2]}。
 * 先按小题名称对位，缺失的按顺序补齐；每个分数按各自小题的满分范围 + 全局步长归一化。
 * mainStep：全局评分步长（scoreConfig.step），小题步长已统一跟随全局步长
 */
export function parseSubScores(raw: string, subQs: SubQuestion[], mainStep: number): ParseResult {
  const text = raw.trim()
  const objs = extractJsonObjects(text)
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue
    const arr = (o as Record<string, unknown>)['scores']
    if (!Array.isArray(arr) || !arr.length) continue
    const byName = new Map<string, number>()
    const reasonByName = new Map<string, string>()
    arr.forEach((v) => {
      const name = pickSubName(v)
      const score = pickSubScore(v)
      if (name && score !== undefined) byName.set(name, score)
      const r = pickSubReason(v)
      if (name && r) reasonByName.set(name, r)
    })
    const ordered = arr.map((v) => pickSubScore(v))
    const orderedReasons = arr.map((v) => pickSubReason(v))
    const scores = subQs.map((sq, idx) => {
      const named = byName.get(sq.name)
      const byIdx = ordered[idx]
      return named ?? byIdx
    })
    if (scores.some((v) => v === undefined)) continue
    const normalized = scores.map((v, idx) =>
      normalizeScoreForConfig(v as number, { total: subQs[idx].maxScore, min: 0, max: subQs[idx].maxScore, step: mainStep }, subQs[idx])
    )
    const subReasons = subQs.map((sq, idx) => reasonByName.get(sq.name) ?? orderedReasons[idx])
    return {
      ok: true,
      scores: normalized,
      reason: `小题分解析成功：${normalized.join(' / ')}`,
      subReasons
    }
  }
  return {
    ok: false,
    error: `无法解析各小题分数（期望 ${subQs.length} 个分数的 scores 数组）`,
    reason: text.slice(0, 300)
  }
}
