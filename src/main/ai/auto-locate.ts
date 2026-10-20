import { screen } from 'electron'
import type { AutoLocateResult } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { resolveProviderRef } from '@main/ai/resolve'
import { buildThinkingParams } from '@main/ai/registry'
import { logger } from '@main/services/logger'
import { captureRegion } from '@main/services/screenshot'
import { getSidebarWindow } from '@main/windows'
import { genId, sleep } from '@main/utils'

/** 归一化坐标框（0–1000，相对整图） */
interface NormBox {
  x: number
  y: number
  w: number
  h: number
}

const SYSTEM_PROMPT =
  '你是屏幕 UI 元素定位专家，擅长从应用截图中精确定位界面元素的位置。只输出严格 JSON，不输出任何解释或代码围栏。'

const USER_PROMPT = `这是一张阅卷系统界面的屏幕截图。请定位以下元素，坐标使用 0-1000 归一化值（相对整张图片，左上角为 0,0，右下角为 1000,1000）：
{
  "answer": {"x":..,"y":..,"w":..,"h":..},
  "score": {"x":..,"y":..,"w":..,"h":..},
  "scoreBoxes": [{"x":..,"y":..,"w":..,"h":..}],
  "inputs": [{"x":..,"y":..,"w":..,"h":..}],
  "buttons": [{"text":"按钮文字","x":..,"y":..,"w":..,"h":..}],
  "submit": {"x":..,"y":..,"w":..,"h":..}
}
元素说明：
- answer：学生作答内容（手写作答图片/答题卡）所在区域的最大外接矩形，不含题目列表、导航、工具栏等无关区域。必须给出。
- score：填写本题「总分」的分数输入框（与提交按钮相邻、同一评分操作栏）。若界面上有多个分数输入框（如各小题分别给分），必须选整题总分的那个，切勿选小题分数输入框。找不到填 null。
- scoreBoxes：分小题给分的分数输入框数组（不含整题总分输入框），按从上到下、从左到右顺序排列；界面上没有分小题输入框时填 null。
- inputs：界面上所有可输入文本的输入框（含分数输入框）组成的数组。找不到填 null。
- buttons：界面上所有带可见文字的按钮组成的数组，必须逐一读出每个按钮的文字填入 text 字段（如「提交」「确定」「对」「错」）。找不到填 null。
- submit：提交本次评分的按钮（文字通常为「提交」「确定」「下一份」等）。找不到填 null。
要求：矩形完整包住目标元素且边距尽量小；只输出上述 JSON，不要任何其他文字。`

/** 从模型输出中提取 JSON 对象（容忍代码围栏 / 前后杂文） */
function extractJson(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/```(?:json)?/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 校验并夹取归一化框；无效返回 null */
function normBox(v: unknown): NormBox | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(o[k]))
  if (nums.some((n) => !Number.isFinite(n))) return null
  let [x, y, w, h] = nums
  x = Math.min(Math.max(x, 0), 1000)
  y = Math.min(Math.max(y, 0), 1000)
  w = Math.min(Math.max(w, 0), 1000 - x)
  h = Math.min(Math.max(h, 0), 1000 - y)
  if (w < 4 || h < 4) return null
  return { x, y, w, h }
}

/** 两框中心距离（归一化单位） */
function boxDist(a: NormBox, b: NormBox): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2)
  const dy = a.y + a.h / 2 - (b.y + b.h / 2)
  return Math.hypot(dx, dy)
}

/** 两框是否有交集 */
function boxOverlaps(a: NormBox, b: NormBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 提交按钮文字匹配优先级：提交 > 确定 > 下一份/题/卷 > 保存/完成 */
const SUBMIT_TEXT_TIERS: RegExp[] = [/提交/, /确定/, /下一[题份卷]/, /保存|完成/]

/**
 * AI 一键定位：截取阅卷系统所在屏幕 → 视觉模型识别答题区域/分值输入框/提交按钮/数字面板
 * → 返回预览图（含图内像素框）与可直接保存的 Region（DIP 坐标）。
 */
export async function autoLocateRegions(): Promise<AutoLocateResult> {
  const cfg = configStore.get()
  // 目标显示器：优先沿用已标记答题区域所在屏，否则主屏
  const displays = screen.getAllDisplays()
  const prevAnswer = cfg.regions.answer
  const display =
    displays.find((d) => d.id === prevAnswer?.displayId) ?? screen.getPrimaryDisplay()

  // 隐藏侧边栏，避免悬浮面板被截进画面（仅截屏瞬间隐藏，AI 识别期间恢复显示）
  const sidebar = getSidebarWindow()
  const sidebarWasVisible = sidebar ? sidebar.isVisible() : false
  if (sidebar && sidebarWasVisible) {
    sidebar.hide()
    await sleep(450)
  }
  let captured: Awaited<ReturnType<typeof captureRegion>>
  try {
    const b = display.bounds
    captured = await captureRegion({ x: b.x, y: b.y, w: b.width, h: b.height }, display.id)
  } finally {
    if (sidebar && sidebarWasVisible && !sidebar.isDestroyed()) {
      sidebar.show()
      sidebar.focus()
    }
  }
  try {
    // 预览/AI 输入用缩放图（同一张，保证叠加框与识别坐标一致）
    const orig = captured.getSize()
    const maxW = 1440
    const scaled = orig.width > maxW ? captured.resize({ width: maxW }) : captured
    const imgSize = scaled.getSize()
    const dataUrl = scaled.toDataURL()

    // 视觉模型：优先识别（OCR）角色，未配置时回退评分模型的多模态模型
    let target: ReturnType<typeof resolveProviderRef>
    try {
      target = resolveProviderRef(cfg.workflow.roles.ocr, 'ocr')
    } catch {
      target = resolveProviderRef(cfg.workflow.roles.grader, 'vision')
    }
    const think = buildThinkingParams(target.providerKind ?? 'custom')
    const model = think.modelOverride ?? target.model
    const res = await target.adapter.chat({
      model,
      system: SYSTEM_PROMPT,
      prompt: USER_PROMPT,
      imageDataUrls: [dataUrl],
      timeoutMs: target.timeoutMs,
      extra: think.extra,
      jsonMode: true
    })
    const parsed = extractJson(res.text)
    if (!parsed) {
      logger.error({ phase: 'autoLocate', provider: target.name, model, latencyMs: res.latencyMs, rawResponse: res.text.slice(0, 2000), error: '模型输出无法解析为 JSON' })
      return { ok: false, error: 'AI 返回内容无法解析，请重试或改用手动标记' }
    }

    const labels: Record<'answer' | 'score' | 'submit', string> = {
      answer: '答题区域',
      score: '分值输入框',
      submit: '提交按钮'
    }
    const boxes: AutoLocateResult['boxes'] = {}
    const regions: NonNullable<AutoLocateResult['regions']> = {}
    const missing: string[] = []
    // 物理像素 → DIP 换算（截屏实际尺寸与显示器 DIP 尺寸之比）
    const physPerDipX = orig.width / display.size.width
    const physPerDipY = orig.height / display.size.height
    /** 归一化框 → 预览图内像素坐标 */
    const toPreview = (nb: NormBox) => ({
      x: (nb.x / 1000) * imgSize.width,
      y: (nb.y / 1000) * imgSize.height,
      w: (nb.w / 1000) * imgSize.width,
      h: (nb.h / 1000) * imgSize.height
    })
    /** 归一化框 → DIP 全局坐标 */
    const toDip = (nb: NormBox) => ({
      x: display.bounds.x + ((nb.x / 1000) * orig.width) / physPerDipX,
      y: display.bounds.y + ((nb.y / 1000) * orig.height) / physPerDipY,
      w: ((nb.w / 1000) * orig.width) / physPerDipX,
      h: ((nb.h / 1000) * orig.height) / physPerDipY
    })
    // ---- 决策：视觉模型「读字」远比「语义选元素」可靠 ----
    // 1) 提交按钮：按按钮文字优先级匹配（提交 > 确定 > 下一份/题/卷 > 保存/完成），
    //    多个候选时取离分值框最近的（评分操作栏内分值框与提交按钮相邻）；无匹配回退模型给的 submit
    // 2) 分值输入框：缺失或距提交按钮过远（>350 归一化距离）时，从输入框清单中就近重选
    const normButtons: { text: string; box: NormBox }[] = Array.isArray(parsed.buttons)
      ? (parsed.buttons as unknown[])
          .map((b) => {
            if (!b || typeof b !== 'object') return null
            const o = b as Record<string, unknown>
            const nb = normBox(o)
            const text = typeof o.text === 'string' ? o.text.trim() : ''
            return nb && text ? { text, box: nb } : null
          })
          .filter((b): b is { text: string; box: NormBox } => b !== null)
      : []
    const normInputs: NormBox[] = Array.isArray(parsed.inputs)
      ? (parsed.inputs as unknown[]).map(normBox).filter((b): b is NormBox => b !== null)
      : []
    const normAnswer = normBox(parsed.answer)
    let normScore = normBox(parsed.score)
    let normSubmit = normBox(parsed.submit)
    const rawSubs: NormBox[] = Array.isArray(parsed.scoreBoxes)
      ? (parsed.scoreBoxes as unknown[]).map(normBox).filter((b): b is NormBox => b !== null)
      : []
    // 分小题场景（≥2 个小题分框）：各小题分值提交后平台自动累计总分，无需整题总分输入框
    const subMode = rawSubs.length >= 2
    const notes: string[] = []
    for (const re of SUBMIT_TEXT_TIERS) {
      const matched = normButtons.filter((b) => re.test(b.text))
      if (!matched.length) continue
      // 分小题模式优先选紧邻小题分框的提交按钮（提交小题分即累计总分）；
      // 单题模式优先排除紧邻小题分框的候选（小题面板自带的提交按钮不是整题提交按钮）
      let pool = matched
      if (subMode) {
        const near = matched.filter((b) => rawSubs.some((s) => boxDist(s, b.box) <= 150))
        if (near.length) pool = near
      } else {
        const main = matched.filter((b) => !rawSubs.some((s) => boxDist(s, b.box) <= 150))
        if (main.length) pool = main
      }
      const pick = !subMode && normScore
        ? [...pool].sort((a, b) => boxDist(a.box, normScore!) - boxDist(b.box, normScore!))[0]
        : [...pool].sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0]
      if (pick) {
        normSubmit = pick.box
        notes.push(`提交按钮按文字「${pick.text}」选定`)
        break
      }
    }
    if (subMode) {
      normScore = null
      notes.push('分小题模式：小题分值提交后平台自动累计总分，不再标记整题总分框')
    }
    const submitRef = normSubmit
    if (!subMode && submitRef && (!normScore || boxDist(normScore, submitRef) > 350)) {
      // 候选剔除与小题分框重叠的输入框：整题分值输入框不在小题评分面板内
      const near = normInputs
        .filter(
          (inp) => boxDist(inp, submitRef) <= 350 && !rawSubs.some((s) => boxOverlaps(s, inp))
        )
        .sort((a, b) => boxDist(a, submitRef) - boxDist(b, submitRef))
      if (near.length) {
        normScore = near[0]
        notes.push('分值输入框按「与提交按钮相邻」重选')
      }
    }
    // 仅检测到 1 个分数输入框时视为整题总分输入框
    if (!normScore && rawSubs.length === 1) {
      normScore = rawSubs[0]
      notes.push('分值输入框取自唯一检测到的分数输入框')
    }

    const decided: Record<'answer' | 'score' | 'submit', NormBox | null> = {
      answer: normAnswer,
      score: normScore,
      submit: normSubmit
    }
    for (const key of ['answer', 'score', 'submit'] as const) {
      const nb = decided[key]
      if (!nb) {
        // 分小题模式下总分框为预期缺失，不算未识别
        if (key !== 'score' || !subMode) missing.push(labels[key])
        continue
      }
      boxes[key] = toPreview(nb)
      regions[key] = {
        id: key,
        kind: key,
        label: labels[key],
        displayId: display.id,
        rect: toDip(nb),
        scaleAtMark: display.scaleFactor
      }
    }
    if (!regions.answer) {
      return { ok: false, error: 'AI 未能识别出答题区域，请重试或改用手动标记', dataUrl, imgW: imgSize.width, imgH: imgSize.height }
    }

    // ---- 分小题分值框：检测到多个分数输入框时自动创建对应数量的小题 ----
    // 小题不再手动配置：每题满分 = 总分值/题数（0.5 步进取整，下限 0.5，未配置总分时取 1.5），
    // 评分标准统一引用整体评分标准；与总分输入框重叠的框视为总分框本身，从小题框中剔除
    const normSubs: NormBox[] = rawSubs.filter((b) => !(normScore && boxOverlaps(b, normScore)))
    const subBoxes = normSubs.map(toPreview)
    let subQuestions: AutoLocateResult['subQuestions']
    let subBound = 0
    let subAutoCreated = false
    if (normSubs.length >= 2) {
      const n = normSubs.length
      const perMax =
        cfg.scoreConfig.total > 0
          ? Math.max(0.5, Math.round((cfg.scoreConfig.total / n) * 2) / 2)
          : 1.5
      const perStep = perMax % 1 === 0 ? 1 : 0.5
      subAutoCreated = true
      subQuestions = normSubs.map((_, i) => ({
        id: genId('sub'),
        name: `小题${i + 1}`,
        enabled: true,
        scoreBoxId: null,
        maxScore: perMax,
        minScore: 0,
        step: perStep,
        rulesPrompt: ''
      }))
      for (let i = 0; i < n; i++) {
        const regionId = `sub:${subQuestions[i].id}`
        regions[regionId] = {
          id: regionId,
          kind: 'score',
          label: `${subQuestions[i].name} 分值框`,
          displayId: display.id,
          rect: toDip(normSubs[i]),
          scaleAtMark: display.scaleFactor
        }
        subQuestions[i] = { ...subQuestions[i], scoreBoxId: regionId }
        subBound++
      }
    }
    logger.info({
      phase: 'autoLocate',
      provider: target.name,
      model,
      latencyMs: res.latencyMs,
      detail: `识别成功：${Object.keys(regions).join('、')}${subBound ? `；绑定小题分值框 ${subBound} 个${subAutoCreated ? '（自动创建）' : ''}` : ''}${notes.length ? `；${notes.join('；')}` : ''}${missing.length ? `；未识别：${missing.join('、')}` : ''}`
    })
    return {
      ok: true,
      dataUrl,
      imgW: imgSize.width,
      imgH: imgSize.height,
      boxes,
      ...(subBoxes.length ? { subBoxes } : {}),
      ...(subBound ? { subQuestions, subBound, subAutoCreated } : {}),
      ...(subMode ? { dropScore: true } : {}),
      regions,
      missing,
      note: `${target.name} · ${model} · ${(res.latencyMs / 1000).toFixed(1)}s`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ phase: 'autoLocate', error: msg })
    return { ok: false, error: `一键定位失败：${msg}` }
  }
}
