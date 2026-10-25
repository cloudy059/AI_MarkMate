import type { AppConfig, QuestionRecord } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { logger } from '@main/services/logger'
import { resolveProviderRef } from '@main/ai/resolve'
import { buildThinkingParams } from '@main/ai/registry'
import { stripEmbeddedImages } from './prompt-builder'
import { gradingEngine } from './state-machine'

// ============================================================
// 阅卷后答题分析：汇总本场全部批改记录 → 本地统计 + AI 生成报告
// ============================================================

/** 文本截断（去除嵌入图片，避免 prompt 过长） */
function truncate(s: string | undefined, n: number): string {
  if (!s) return ''
  const t = stripEmbeddedImages(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 本地统计：份数/平均/最值/分数分布/小题得分率/纠错仲裁计数 */
function buildLocalStats(records: QuestionRecord[], cfg: AppConfig): string {
  const scored = records.filter((r) => typeof r.finalScore === 'number')
  if (!scored.length) throw new Error('本次批改暂无有效得分记录，无法分析')
  const scores = scored.map((r) => r.finalScore as number)
  const avg = scores.reduce((s, v) => s + v, 0) / scores.length
  const dist = new Map<string, number>()
  for (const s of scores) {
    const k = String(Number(s.toFixed(2)))
    dist.set(k, (dist.get(k) ?? 0) + 1)
  }
  const distText = [...dist.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([k, c]) => `${k}分×${c}人`)
    .join('，')
  const lines: string[] = [
    `批改份数：${records.length}（提交 ${records.filter((r) => r.submitStatus === 'auto' || r.submitStatus === 'manual').length}，跳过/失败 ${records.filter((r) => r.submitStatus === 'skipped' || r.submitStatus === 'failed').length}）`,
    `有效得分份数：${scored.length}`,
    `平均分：${avg.toFixed(2)} / 满分 ${cfg.scoreConfig.total}`,
    `最高分：${Math.max(...scores).toFixed(2)}，最低分：${Math.min(...scores).toFixed(2)}`,
    `教师纠错份数：${records.filter((r) => r.corrected).length}`,
    `人工仲裁份数：${records.filter((r) => r.arbited || r.subScores.some((s) => s.arbited)).length}`,
    `分数分布：${distText}`
  ]
  const subQs = cfg.subQuestions.filter((s) => s.enabled)
  if (subQs.length > 1) {
    const st = new Map<string, { sum: number; n: number }>()
    for (const r of scored) {
      for (const s of r.subScores) {
        if (typeof s.finalScore === 'number') {
          const cur = st.get(s.subId) ?? { sum: 0, n: 0 }
          cur.sum += s.finalScore
          cur.n += 1
          st.set(s.subId, cur)
        }
      }
    }
    lines.push(
      '各小题平均得分：' +
        subQs
          .map((q) => {
            const d = st.get(q.id)
            const rate = d && d.n ? ((d.sum / d.n) / q.maxScore) * 100 : null
            return `${q.name} ${d && d.n ? `${(d.sum / d.n).toFixed(2)}/${q.maxScore}分（得分率${rate?.toFixed(1)}%）` : '无数据'}`
          })
          .join('；')
    )
  }
  return lines.join('\n')
}

/** 学生逐份明细：总分、小题分、作答与评分理由摘要 */
function buildDetailLines(records: QuestionRecord[]): string {
  return records
    .map((r, i) => {
      const parts: string[] = [`第 ${i + 1} 卷：总分 ${r.finalScore ?? '—'}`]
      if (r.subScores.length) {
        parts.push(`小题得分：${r.subScores.map((s) => `${s.name}=${s.finalScore ?? '?'}`).join('，')}`)
      }
      const ocr = truncate(r.ocrText, 200)
      if (ocr) parts.push(`作答摘要：${ocr}`)
      const reason = truncate(r.reasoning, 150)
      if (reason) parts.push(`评分要点：${reason}`)
      if (r.corrected) parts.push('（教师已纠错）')
      if (r.submitStatus === 'skipped' || r.submitStatus === 'failed') parts.push('（未提交/跳过）')
      return parts.join(' ｜ ')
    })
    .join('\n')
}

/** 生成阅卷后答题分析报告（Markdown），无记录或无有效得分时抛错 */
export async function runAnalysis(): Promise<string> {
  const records = gradingEngine.getSessionRecords()
  if (!records.length) throw new Error('暂无已批改记录，请先完成一次批改')
  const cfg = configStore.get()
  const stats = buildLocalStats(records, cfg)
  const subQs = cfg.subQuestions.filter((s) => s.enabled)
  const standard = cfg.scoringStandards[cfg.activeStandardIndex] ?? null

  const target = resolveProviderRef(cfg.workflow.roles.grader, 'chat')
  const think = buildThinkingParams(target.providerKind ?? 'custom')
  const model = think.modelOverride ?? target.model

  const lines: string[] = [
    '请基于以下 AI 阅卷的批改数据，生成一份面向教师的答题情况分析报告。',
    '',
    '## 题目背景',
    `题目：${standard?.name ?? '（未命名）'}`,
    standard?.questionStem.trim() ? `【题干】\n${truncate(standard.questionStem, 400)}` : '',
    subQs.length > 1
      ? `【小题构成】${subQs.map((q) => `${q.name}（满分 ${q.maxScore} 分）`).join('，')}；整卷满分 ${cfg.scoreConfig.total} 分`
      : `整卷满分 ${cfg.scoreConfig.total} 分`,
    cfg.workflow.rulesPrompt.trim() ? `【全局评分规则】\n${truncate(cfg.workflow.rulesPrompt, 200)}` : '',
    '',
    '## 本场批改统计（已由系统准确计算，直接引用）',
    stats,
    '',
    '## 学生逐份得分明细',
    buildDetailLines(records),
    '',
    '## 输出要求',
    '用 Markdown 输出报告，以「# 答题情况分析报告」开头，包含以下小节（标题固定）：',
    '## 一、整体表现',
    '结合平均分、得分率与满分情况，概括班级整体掌握水平。',
    '## 二、分数分布',
    '分析分数段分布特征（如两极分化、集中区间、异常值）。',
    '## 三、薄弱小题与知识点',
    '依据小题得分率与作答摘要，定位得分率最低的知识点，分析典型失分原因。',
    '## 四、共性错误分析',
    '归纳多份答卷中反复出现的错误类型（概念不清、步骤缺失、计算失误等），引用具体卷面证据。',
    '## 五、教学建议',
    '给出可落地的教学与复习建议。',
    '要求：结论必须基于上述真实数据，引用分数时与统计保持一致，不虚构学生作答；数学公式用 LaTeX 表示。'
  ]

  const t0 = Date.now()
  const res = await target.adapter.chat({
    model,
    system:
      '你是资深的学科教研分析专家，擅长根据班级测试数据撰写客观、具体、可执行的答题情况分析报告，为教师后续教学提供依据。',
    prompt: lines.filter(Boolean).join('\n'),
    timeoutMs: target.timeoutMs,
    extra: think.extra
  })
  logger.info({
    phase: 'analysis',
    provider: target.name,
    model,
    latencyMs: res.latencyMs,
    detail: `答题分析报告生成完成：${res.text.length} 字`
  })
  return res.text
}
