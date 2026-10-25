import type { CorrectionAnalysisSections, CorrectionAnalyzeRequest, ScoringStandard } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { logger } from '@main/services/logger'
import { resolveProviderRef } from '@main/ai/resolve'
import { buildThinkingParams } from '@main/ai/registry'
import { stripEmbeddedImages } from './prompt-builder'

// ============================================================
// AI 纠错第二步：差异分析 + 评分标准优化建议（流式）
// ============================================================

const NO_CHANGE_TOKENS = ['（无需修改）', '(无需修改)', '无变化', '不需要修改', '无需修改']

/** 该小节是否表示无需修改 */
export function isNoChange(text: string): boolean {
  const t = text.trim()
  return !t || NO_CHANGE_TOKENS.some((k) => t === k || t.replace(/[\s*]/g, '') === k)
}

/** 按 '## 标题' 切分小节（兼容标题前后空白与粗体变体） */
function splitSection(text: string, titles: string[]): string | undefined {
  const lines = text.split('\n')
  const starts: number[] = []
  lines.forEach((line, i) => {
    const h = line.trim()
    if (titles.some((t) => h === `## ${t}` || h === `### ${t}` || h === `**${t}**`)) starts.push(i)
  })
  if (!starts.length) return undefined
  const begin = starts[0]
  // 取标题后的正文直到下一个 '## ' 标题
  let end = lines.length
  for (let i = begin + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i].trim())) {
      end = i
      break
    }
  }
  return lines.slice(begin + 1, end).join('\n').trim()
}

/** 将 AI 流式输出解析为三个小节；小节缺失或标记无需修改时返回空串（不更新） */
export function parseAnalysisSections(text: string): CorrectionAnalysisSections {
  const reason = splitSection(text, ['修改理由', '差异分析', '分析'])
  const ref = splitSection(text, ['新参考答案', '参考答案优化', '优化后的参考答案'])
  const rubric = splitSection(text, ['新评分标准', '评分标准优化', '优化后的评分标准'])
  return {
    reason: reason ?? text.trim(),
    newReferenceAnswer: ref && !isNoChange(ref) ? ref : '',
    newRubric: rubric && !isNoChange(rubric) ? rubric : ''
  }
}

/** 构建差异分析提示词：当前评分标准 + 双方评分对比 */
function buildAnalyzePrompt(req: CorrectionAnalyzeRequest, standard: ScoringStandard | null): { system: string; prompt: string } {
  const cfg = configStore.get()
  const r = req.record
  const subQs = cfg.subQuestions.filter((s) => s.enabled)
  const aiSubs = r.subScores.map((s) => `  - ${s.name}：AI 给 ${s.finalScore ?? s.scoreA ?? '?'} 分${s.reason ? `（理由：${s.reason}）` : ''}`).join('\n')
  const teacherSubs = subQs.length
    ? subQs.map((sq, i) => `  - ${sq.name}：教师给 ${req.teacherScores[i] ?? '?'} 分`).join('\n')
    : `  - 整题：教师给 ${req.teacherScores[0] ?? '?'} 分`
  const lines: string[] = [
    '请分析以下 AI 阅卷评分与教师评分的差异，并给出评分标准优化建议。',
    '',
    '## 背景',
    `题目：${standard?.name ?? '（未命名）'}`,
    standard?.questionStem.trim() ? `【题目题干】\n${stripEmbeddedImages(standard.questionStem)}` : '',
    standard?.referenceAnswer.trim() ? `【当前参考答案】\n${stripEmbeddedImages(standard.referenceAnswer)}` : '（当前无参考答案）',
    standard?.rubric.trim() ? `【当前评分标准】\n${stripEmbeddedImages(standard.rubric)}` : '（当前无评分标准）',
    cfg.workflow.rulesPrompt.trim() ? `【全局批改规则】\n${stripEmbeddedImages(cfg.workflow.rulesPrompt)}` : '',
    '',
    '## 学生作答',
    r.ocrText?.trim() ? `【OCR 识别文本】\n${r.ocrText}` : '（多模态直评模式，本次无 OCR 转录文本）',
    '',
    '## 双方评分对比',
    `AI 总分：${r.finalScore ?? '?'}`,
    aiSubs ? `AI 各题给分：\n${aiSubs}` : '',
    r.reasoning?.trim() ? `AI 评分理由：${stripEmbeddedImages(r.reasoning)}` : '',
    `教师总分：${subQs.length ? req.teacherScores.reduce((s, v) => s + (v || 0), 0) : req.teacherScores[0] ?? '?'}`,
    `教师各题给分：\n${teacherSubs}`,
    req.reasoning.trim() ? `教师评分理由：${req.reasoning.trim()}` : '（教师未填写理由）',
    '',
    '## 输出格式（必须严格遵守）',
    '用 Markdown 输出以下三个小节，小节标题固定不变：',
    '## 修改理由',
    '分析差异的可能原因（OCR 识别不准、评分标准不完善、模型理解偏差等），指出当前评分标准或参考答案的具体不足。',
    '## 新参考答案',
    '给出优化后的完整参考答案；如无需修改，仅输出：（无需修改）',
    '## 新评分标准',
    '给出优化后的完整评分标准（可直接用于后续 AI 批改）；如无需修改，仅输出：（无需修改）',
    '数学公式用 LaTeX 表示。不要输出其他内容。'
  ]
  return {
    system: '你是阅卷质量分析专家，擅长定位 AI 评分与教师评分的差异原因，并给出可落地的评分标准优化建议。分析客观、具体、可执行。',
    prompt: lines.filter(Boolean).join('\n')
  }
}

/** 流式执行差异分析：增量经 onDelta 推送，返回完整文本 */
export async function runCorrectionAnalysis(
  req: CorrectionAnalyzeRequest,
  onDelta: (delta: string) => void
): Promise<{ sections: CorrectionAnalysisSections; text: string }> {
  const cfg = configStore.get()
  const target = resolveProviderRef(cfg.workflow.roles.grader, 'chat')
  const think = buildThinkingParams(target.providerKind ?? 'custom')
  const model = think.modelOverride ?? target.model
  const standard = cfg.scoringStandards[cfg.activeStandardIndex] ?? null
  const { system, prompt } = buildAnalyzePrompt(req, standard)
  const t0 = Date.now()
  const text = await target.adapter.chatStream(
    {
      model,
      system,
      prompt,
      timeoutMs: target.timeoutMs,
      extra: think.extra
    },
    onDelta
  )
  logger.info({
    phase: 'correction',
    seq: req.record.seq,
    provider: target.name,
    model,
    latencyMs: Date.now() - t0,
    detail: `纠错分析完成：${text.length} 字`
  })
  return { sections: parseAnalysisSections(text), text }
}

/** 流式执行评分理由润色 */
export async function runReasonPolish(
  text: string,
  recordSeq: number,
  onDelta: (delta: string) => void
): Promise<string> {
  const cfg = configStore.get()
  const target = resolveProviderRef(cfg.workflow.roles.grader, 'chat')
  const think = buildThinkingParams(target.providerKind ?? 'custom')
  const model = think.modelOverride ?? target.model
  const t0 = Date.now()
  const out = await target.adapter.chatStream(
    {
      model,
      system:
        '你是给学生的评分评语润色助手。在保留原意与分数判定不变的前提下，把教师的评分理由改写得更通顺、专业、有温度：\n' +
        '1. 保留 Markdown 格式与 LaTeX 公式\n' +
        '2. 补充具体得分点/失分点说明，但不虚构\n' +
        '3. 语气鼓励中肯，适合直接展示给学生\n' +
        '4. 直接输出润色后的理由，不要任何解释',
      prompt: `请润色以下评分理由：\n\n${text}`,
      timeoutMs: target.timeoutMs,
      extra: think.extra
    },
    onDelta
  )
  logger.info({
    phase: 'correction',
    seq: recordSeq,
    provider: target.name,
    model,
    latencyMs: Date.now() - t0,
    detail: `评分理由 AI 润色完成：${out.length} 字`
  })
  return out
}
