import type { ScoreConfig, ScoringStandard, SubQuestion } from '@shared/types'

export const OCR_SYSTEM_PROMPT = `你是专业的答题卡识别引擎（OCR）。请将图片中学生的作答内容完整、忠实地转录为纯文本，规则：
1. 保持学生原始作答顺序与表述，不改写、不补充、不省略、不纠错
2. 数学公式、化学方程式等一律转换为 LaTeX（行内用 $...$，独立公式用 $$...$$）
3. 无法转录的图形/图表用 [图] 占位标注
4. 答案为空白时输出：（空白）
5. 只输出转录结果本身，不要任何解释说明`

export const OCR_USER_PROMPT = '请转录这张答题卡图片中学生的全部作答内容。'

export interface GradingPromptContext {
  standard: ScoringStandard | null
  scoreConfig: ScoreConfig
  globalRules: string
  /** 分小题模式：一次评完全部小题；空 = 整题评分 */
  subQs?: SubQuestion[]
  /** 示例参考图片是否已随请求附图 */
  sampleImageCount: number
  /** 深度思考以提示词注入（厂商无原生参数时） */
  thinkByPrompt: boolean
}

function section(title: string, body: string): string {
  const b = stripEmbeddedImages(body).trim()
  return b ? `## ${title}\n${b}\n` : ''
}

/** 剥离嵌入图（stdimg:// / data:）为 [图] 占位：图片随请求附图发送，避免 base64 撑爆提示词 */
export function stripEmbeddedImages(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(stdimg:\/\/[^)\s]+\)/g, '[图]')
    .replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[图]')
}

function formatScoreRange(cfg: ScoreConfig): string {
  const parts = [`满分 ${cfg.total} 分`, `最低 ${cfg.min} 分`, `最高 ${cfg.max} 分`]
  if (cfg.step > 0) parts.push(`打分步长 ${cfg.step}（分数必须是 ${cfg.step} 的整数倍）`)
  return parts.join('，')
}

export function buildGradingSystemPrompt(ctx: GradingPromptContext): string {
  const s = ctx.standard
  const subs = ctx.subQs ?? []
  const cfg = subs.length === 1 ? { total: subs[0].maxScore, min: subs[0].minScore, max: subs[0].maxScore, step: subs[0].step } : ctx.scoreConfig
  const lines: string[] = []
  lines.push(`你是一位严谨、经验丰富、打分客观一致的人民教师，正在批改学生作答。`)
  lines.push('')
  lines.push(`## 输出格式（必须严格遵守）`)
  lines.push(`只输出一个 JSON 对象，不要 markdown 代码块，不要多余文字。`)
  if (subs.length) {
    lines.push(`本题包含 ${subs.length} 个小题，需分别给分，格式：`)
    lines.push(`{"scores": [{"name": "<小题名称>", "score": <数字>}, ...]}`)
    lines.push(`scores 数组必须包含且仅包含全部 ${subs.length} 个小题，name 与下方小题名称完全一致。`)
    lines.push(`各小题给分要求：`)
    subs.forEach((sq, i) => {
      lines.push(`${i + 1}. ${sq.name}：${formatScoreRange({ total: sq.maxScore, min: sq.minScore, max: sq.maxScore, step: sq.step })}`)
    })
  } else {
    lines.push(`格式：`)
    lines.push(`{"reason": "评分依据（60字以内）", "score": <数字>}`)
    lines.push(`score 必须为数字，${formatScoreRange(cfg)}。`)
  }
  lines.push('')
  if (ctx.thinkByPrompt) {
    lines.push(`## 思考要求`)
    lines.push(`请先在内部逐步对照评分标准检查得分点/失分点，再给出最终分数（思考过程不要出现在输出中）。`)
    lines.push('')
  }
  if (ctx.globalRules.trim()) {
    lines.push(section('全局批改规则', ctx.globalRules))
  }
  if (subs.length === 1) {
    lines.push(section(`当前批改对象：第 ${subs[0].name} 小题`, subs[0].rulesPrompt))
  } else if (subs.length >= 2) {
    const withRules = subs.filter((sq) => sq.rulesPrompt.trim())
    if (withRules.length) {
      const body = subs
        .filter((sq) => sq.rulesPrompt.trim())
        .map((sq) => `【${sq.name}】\n${sq.rulesPrompt.trim()}`)
        .join('\n\n')
      lines.push(section('各小题评分要点', body))
    }
  }
  if (s) {
    if (s.questionStem.trim()) lines.push(section('题目题干', s.questionStem))
    if (s.answerRequirement.trim()) lines.push(section('作答要求', s.answerRequirement))
    if (s.rubric.trim()) lines.push(section('评分标准（评分细则）', s.rubric))
    if (s.referenceAnswer.trim()) lines.push(section('参考答案', s.referenceAnswer))
    const sample = s.sampleAnswer.trim()
    if (sample || ctx.sampleImageCount > 0) {
      lines.push(section('示例参考', `${sample}${ctx.sampleImageCount > 0 ? `\n（另附 ${ctx.sampleImageCount} 张参考图片）` : ''}`))
    }
  }
  return lines.filter(Boolean).join('\n')
}

export function buildGradingUserPrompt(ocrText: string | undefined, hasAnswerImage: boolean): string {
  if (hasAnswerImage) {
    return ocrText
      ? `答题卡图片见附图，其 OCR 初步转录如下（以图片为准）：\n\n${ocrText}\n\n请批改并按格式输出 JSON 分数。`
      : '请批改附图答题卡中学生的作答，并按格式输出 JSON 分数。'
  }
  return `学生作答内容（OCR 转录）如下：\n\n${ocrText ?? '（空白）'}\n\n请批改并按格式输出 JSON 分数。`
}
