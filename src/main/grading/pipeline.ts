import { app, nativeImage, type NativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ProviderRef, ScoringStandard, SubQuestion } from '@shared/types'
import { isStandardUsable } from '@shared/types'
import { resolveProviderRef } from '@main/ai/resolve'
import { buildThinkingParams } from '@main/ai/registry'
import { logger } from '@main/services/logger'
import {
  OCR_SYSTEM_PROMPT,
  OCR_USER_PROMPT,
  buildGradingSystemPrompt,
  buildGradingUserPrompt
} from './prompt-builder'
import { parseScore, parseSubScores, type ParseResult } from './score-parser'

export interface OcrOutcome {
  text: string
  provider: string
  model: string
  latencyMs: number
}

export interface GradeOutcome {
  parse: ParseResult
  raw: string
  provider: string
  model: string
  latencyMs: number
  deepThinkNote: string
}

/** 提取标准文本中嵌入的 stdimg:// 图片相对路径（按出现顺序去重） */
export function extractEmbeddedImages(standard: ScoringStandard | null): string[] {
  if (!standard) return []
  const fields = [
    standard.questionStem,
    standard.referenceAnswer,
    standard.rubric,
    standard.answerRequirement,
    standard.sampleAnswer
  ]
  const rels: string[] = []
  for (const f of fields) {
    for (const m of f.matchAll(/!\[[^\]]*\]\(stdimg:\/\/local\/([^)\s]+)\)/g)) {
      const rel = decodeURIComponent(m[1])
      if (!rels.includes(rel)) rels.push(rel)
    }
  }
  return rels
}

/** 读取评分标准参考图片：嵌入图（题干图形等）优先，其后为示例参考导入图，共最多 3 张 */
export function loadSampleImages(standard: ScoringStandard | null): string[] {
  if (!standard) return []
  const root = path.join(app.getPath('userData'), 'standards')
  const rels = [...extractEmbeddedImages(standard), ...(standard.sampleImages ?? [])]
  const out: string[] = []
  for (const rel of rels.slice(0, 3)) {
    try {
      const full = path.join(root, rel)
      if (!fs.existsSync(full)) continue
      const img = nativeImage.createFromPath(full)
      if (!img.isEmpty()) out.push(img.toDataURL())
    } catch {
      /* 跳过损坏图片 */
    }
  }
  return out
}

/** 模式 B/C 第一步：识图提取作答文本（LaTeX） */
export async function runOcr(img: NativeImage, cfg: AppConfig, seq: number): Promise<OcrOutcome> {
  const target = resolveProviderRef(cfg.workflow.roles.ocr, 'ocr')
  const think = buildThinkingParams(target.providerKind ?? 'custom')
  const model = think.modelOverride ?? target.model
  const t0 = Date.now()
  const res = await target.adapter.chat({
    model,
    system: OCR_SYSTEM_PROMPT,
    prompt: OCR_USER_PROMPT,
    imageDataUrls: [img.toDataURL()],
    timeoutMs: target.timeoutMs,
    extra: think.extra
  })
  logger.info({
    phase: 'ocr',
    seq,
    provider: target.name,
    model,
    latencyMs: res.latencyMs,
    ocrText: res.text.slice(0, 4000),
    state: 'recognizing'
  })
  return { text: res.text, provider: target.name, model, latencyMs: res.latencyMs }
}

/** 评分一步：模型 A 直评（附图）或 B/C 二次文本评分；分小题时一次返回全部小题分 */
export async function runGrade(opts: {
  cfg: AppConfig
  /** 启用的小题（非空 = 分小题模式，一次评完全部） */
  subQs?: SubQuestion[]
  graderRef: ProviderRef
  /** 模式 A：答题卡整图 */
  answerImage?: NativeImage
  /** 模式 B/C：OCR 转录文本 */
  ocrText?: string
  /** 截屏墨迹占比极低、系统疑似空白卷：user prompt 追加空白判定提示 */
  blankSuspected?: boolean
  seq: number
}): Promise<GradeOutcome> {
  const { cfg, subQs, graderRef, answerImage, ocrText, blankSuspected, seq } = opts
  const purpose: 'vision' | 'chat' = answerImage ? 'vision' : 'chat'
  const target = resolveProviderRef(graderRef, purpose)
  const think = buildThinkingParams(target.providerKind ?? 'custom')
  const model = think.modelOverride ?? target.model
  const standard = cfg.scoringStandards[cfg.activeStandardIndex] ?? null
  if (!isStandardUsable(standard)) {
    throw new Error('当前启用的评分标准为空：请在「评分标准」页至少填写一个子页内容')
  }
  const sampleImages = purpose === 'vision' ? loadSampleImages(standard) : []
  const system = buildGradingSystemPrompt({
    standard,
    scoreConfig: cfg.scoreConfig,
    globalRules: cfg.workflow.rulesPrompt,
    subQs,
    sampleImageCount: sampleImages.length,
    thinkByPrompt: think.note.includes('提示词')
  })
  const user = buildGradingUserPrompt(ocrText, Boolean(answerImage), blankSuspected)
  const imageDataUrls = answerImage
    ? [answerImage.toDataURL(), ...sampleImages]
    : sampleImages.length
      ? sampleImages
      : undefined
  const t0 = Date.now()
  const res = await target.adapter.chat({
    model,
    system,
    prompt: user,
    imageDataUrls,
    timeoutMs: target.timeoutMs,
    extra: think.extra,
    jsonMode: true
  })
  const parse = subQs?.length
    ? parseSubScores(res.text, subQs, cfg.scoreConfig.step)
    : parseScore(res.text, cfg.scoreConfig, null)
  logger.info({
    phase: 'score',
    seq,
    provider: target.name,
    model,
    latencyMs: res.latencyMs,
    rawResponse: res.text.slice(0, 6000),
    parsedScore: parse.score,
    finalScore: parse.scores ? Number(parse.scores.reduce((s, v) => s + v, 0).toFixed(2)) : undefined,
    error: parse.ok ? undefined : parse.error,
    detail: parse.scores ? `小题分：${parse.scores.join(' / ')}${think.note ? `（${think.note}）` : ''}` : think.note,
    state: 'scoring'
  })
  return {
    parse,
    raw: res.text,
    provider: target.name,
    model,
    latencyMs: res.latencyMs,
    deepThinkNote: think.note
  }
}
