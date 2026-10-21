import type {
  AppConfig,
  GradingEvent,
  GradingState,
  GradingStats,
  GradingStatsPayload,
  QuestionRecord,
  Region,
  ScoringStandard,
  SubQuestion
} from '@shared/types'
import { isStandardUsable } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { logger } from '@main/services/logger'
import { automation } from '@main/services/automation'
import { captureRegion } from '@main/services/screenshot'
import { resolveProviderRef } from '@main/ai/resolve'
import { BLANK_INK_RATIO, dHash, inkRatio, isSameQuestion } from './image-hash'
import { runGrade, runOcr, type GradeOutcome } from './pipeline'
import { normalizeScoreForConfig } from './score-parser'
import { sleep } from '@main/utils'

class LoopAbort extends Error {
  constructor() {
    super('loop-abort')
    this.name = 'LoopAbort'
  }
}

export type ControlAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'confirm'
  | 'reject'
  | 'arbiterApply'
  | 'skip'
  | 'manualScore'

interface Target {
  subQ: SubQuestion | null
  label: string
}

function freshStats(): GradingStats {
  return { total: 0, submitted: 0, failed: 0, arbitrated: 0, avgScore: 0, minScore: 0, maxScore: 0, startedAt: Date.now() }
}

/** 批改循环状态机：capturing → recognizing → scoring(→scoring2→arbitrating) → awaiting_submit → submitting → waiting_next → 循环 */
class GradingEngine {
  private state: GradingState = 'idle'
  private token = 0
  private seq = 0
  private paused = false
  private stats: GradingStats = freshStats()
  private lastRecord: QuestionRecord | null = null
  private lastHash: string | undefined
  /** 连续「页面未翻页」暂停次数：达到 3 次自动暂停批改，等待人工处理 */
  private notAdvancedStreak = 0
  /** 连续空白卷计数：不同空白卷画面几乎一致，无法用哈希判断翻页，超过上限暂停以防页面卡滞 */
  private consecutiveBlanks = 0
  private scoreSum = 0
  private scoreCount = 0
  private scoreMin = Number.POSITIVE_INFINITY
  private scoreMax = Number.NEGATIVE_INFINITY
  private waiter: ((v: unknown) => void) | null = null
  private waitKind: string | null = null
  private emit: (e: GradingEvent) => void = () => undefined

  setEmitter(fn: (e: GradingEvent) => void): void {
    this.emit = fn
  }

  getState(): GradingState {
    return this.state
  }

  getStats(): GradingStatsPayload {
    return { stats: this.stats, state: this.state, lastRecord: this.lastRecord }
  }

  control(action: ControlAction, value?: unknown): { ok: boolean; message?: string } {
    switch (action) {
      case 'start':
        if (this.state !== 'idle') return { ok: false, message: '批改已在进行中' }
        this.paused = false
        this.token += 1
        void this.loop(this.token)
        return { ok: true }
      case 'stop':
        this.token += 1
        this.paused = false
        this.resolveWaiter('stop')
        this.setState('idle')
        this.emitStats()
        return { ok: true }
      case 'pause':
        this.paused = true
        this.resolveWaiter('paused')
        return { ok: true }
      case 'resume':
        this.paused = false
        this.resolveWaiter('resume')
        return { ok: true }
      case 'confirm':
        this.resolveWaiter('confirm')
        return { ok: true }
      case 'reject':
        this.resolveWaiter('reject')
        return { ok: true }
      case 'skip':
        this.resolveWaiter('skip')
        return { ok: true }
      case 'arbiterApply':
        this.resolveWaiter({ score: value })
        return { ok: true }
      case 'manualScore':
        this.resolveWaiter({ score: value })
        return { ok: true }
      default:
        return { ok: false, message: `未知指令：${action}` }
    }
  }

  private resolveWaiter(v: unknown): void {
    const w = this.waiter
    this.waiter = null
    this.waitKind = null
    if (w) w(v)
  }

  private waitUser(kind: string): Promise<unknown> {
    return new Promise((res) => {
      this.waiter = res as (v: unknown) => void
      this.waitKind = kind
    })
  }

  private setState(s: GradingState, message?: string): void {
    this.state = s
    this.emit({ type: 'state', state: s, message })
    if (s.startsWith('paused')) logger.warn({ phase: 'state', state: s, detail: message })
    else logger.info({ phase: 'state', state: s, detail: message })
  }

  private emitStats(): void {
    this.stats.avgScore = this.scoreCount ? Number((this.scoreSum / this.scoreCount).toFixed(2)) : 0
    this.stats.minScore = this.scoreCount ? this.scoreMin : 0
    this.stats.maxScore = this.scoreCount ? this.scoreMax : 0
    this.emit({ type: 'stats', stats: { ...this.stats } })
  }

  private assertToken(myToken: number): void {
    if (this.token !== myToken) throw new LoopAbort()
  }

  private async checkPause(): Promise<void> {
    if (!this.paused) return
    this.setState('paused_manual', '已暂停，等待恢复')
    const r = await this.waitUser('resume')
    if (r === 'stop') throw new LoopAbort()
  }

  /** AI/截屏调用统一重试：指数退避 3 次 → 暂停等用户处理 */
  private async withRetry<T>(myToken: number, seq: number, phase: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.assertToken(myToken)
      try {
        return await fn()
      } catch (err) {
        this.assertToken(myToken)
        const msg = err instanceof Error ? err.message : String(err)
        if (err instanceof LoopAbort) throw err
        if (attempt >= 2) {
          logger.error({ phase, seq, error: msg })
          this.emit({ type: 'error', message: `${phase} 失败：${msg}`, recoverable: true })
          this.setState('paused_provider', msg)
          const r = await this.waitUser('resume')
          if (r === 'stop') throw new LoopAbort()
          attempt = -1
          continue
        }
        logger.warn({ phase, seq, detail: `第 ${attempt + 1} 次失败，即将重试：${msg}` })
        await sleep(2500 * (attempt + 1))
      }
    }
  }

  // ---------- 校验 ----------
  private validate(): string | null {
    const cfg = configStore.get()
    const mainAnswer = cfg.regions.answer
    if (!mainAnswer) return '尚未标记答题区域：请到「答题区域」页框选'
    if (!cfg.regions.submit) return '尚未标记提交按钮位置：请到「答题区域」页点击标记'
    const subQs = cfg.subQuestions.filter((s) => s.enabled)
    if (subQs.length) {
      for (const s of subQs) {
        if (!s.scoreBoxId || !cfg.regions[s.scoreBoxId]) return '小题分值框缺失：请到「答题区域」页重新一键定位'
      }
    } else if (!cfg.regions.score) {
      return '尚未标记分值输入框位置：请到「答题区域」页点击标记'
    }
    const std = cfg.scoringStandards[cfg.activeStandardIndex]
    if (!isStandardUsable(std)) return '当前启用的评分标准为空：请先在「评分标准」页填写内容'
    try {
      resolveProviderRef(cfg.workflow.roles.grader, cfg.workflow.mode === 'A' ? 'vision' : 'chat')
    } catch (err) {
      return `评分模型不可用：${err instanceof Error ? err.message : String(err)}`
    }
    if (cfg.workflow.mode !== 'A') {
      try {
        resolveProviderRef(cfg.workflow.roles.ocr, 'ocr')
      } catch (err) {
        return `识别模型不可用：${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (cfg.workflow.gradingMode === 'double') {
      try {
        resolveProviderRef(cfg.workflow.roles.grader2, cfg.workflow.mode === 'A' ? 'vision' : 'chat')
      } catch (err) {
        return `双评第二模型不可用：${err instanceof Error ? err.message : String(err)}`
      }
    }
    if (!automation.getStatus().ok) return '键鼠自动化不可用：无法自动填写分数与提交'
    return null
  }

  /** 按题型/学科自动匹配预设方案 */
  private autoMatchPreset(cfg: AppConfig, std: ScoringStandard): AppConfig {
    const rulesNonEmpty = (p: AppConfig['presets'][number]) =>
      p.matchRules.questionTypes.length > 0 || p.matchRules.subjects.length > 0
    const hit = cfg.presets.find((p) => {
      if (!rulesNonEmpty(p)) return false
      const typeOk = p.matchRules.questionTypes.length === 0 || p.matchRules.questionTypes.includes(std.questionType)
      const subjOk = p.matchRules.subjects.length === 0 || p.matchRules.subjects.includes(std.subject)
      return typeOk && subjOk
    })
    if (hit) {
      const merged = configStore.patch(hit.snapshot)
      logger.info({ phase: 'preset', detail: `已按题型「${std.questionType}」自动应用预设方案「${hit.name}」` })
      this.emit({ type: 'error', message: `已自动匹配预设方案「${hit.name}」`, recoverable: false })
      return merged
    }
    return cfg
  }

  // ---------- 主循环 ----------
  private async loop(myToken: number): Promise<void> {
    let cfg = configStore.get()
    const session = logger.newSession()
    logger.info({ phase: 'session', detail: `批改会话 ${session} 开始` })

    // 自动匹配预设
    const std = cfg.scoringStandards[cfg.activeStandardIndex]
    if (std) cfg = this.autoMatchPreset(cfg, std)

    const invalid = this.validate()
    if (invalid) {
      this.emit({ type: 'error', message: invalid, recoverable: false })
      this.setState('idle', invalid)
      return
    }

    this.seq = 0
    this.lastHash = undefined
    this.notAdvancedStreak = 0
    this.consecutiveBlanks = 0
    this.lastRecord = null
    this.stats = freshStats()
    this.scoreSum = 0
    this.scoreCount = 0
    this.scoreMin = Number.POSITIVE_INFINITY
    this.scoreMax = Number.NEGATIVE_INFINITY
    this.setState('ready', '批改已就绪，即将开始第一题')

    try {
      while (this.token === myToken) {
        await this.checkPause()
        await this.processQuestion(myToken, session)
        // 达到计划批改份数自动停止
        const planned = configStore.get().workflow.plannedCount ?? 0
        if (planned > 0 && this.stats.submitted >= planned) {
          logger.info({ phase: 'session', detail: `已完成 ${planned} 份批改，自动停止` })
          this.emit({ type: 'error', message: `已完成 ${planned} 份批改，自动停止`, recoverable: false })
          break
        }
      }
    } catch (err) {
      if (err instanceof LoopAbort) {
        logger.info({ phase: 'session', detail: '批改已停止' })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ phase: 'session', error: msg })
        this.emit({ type: 'error', message: `批改异常终止：${msg}`, recoverable: false })
      }
    } finally {
      if (this.token === myToken) this.setState('idle', '批改已结束')
      this.emitStats()
    }
  }

  /** 评分对象：启用的小题（分小题模式）或整题（单题模式） */
  private activeTargets(cfg: AppConfig): Target[] {
    const subQs = cfg.subQuestions.filter((s) => s.enabled)
    if (subQs.length) return subQs.map((s) => ({ subQ: s, label: s.name }))
    return [{ subQ: null, label: '本题' }]
  }

  private async processQuestion(myToken: number, session: string): Promise<void> {
    let cfg = configStore.get()
    const answerRegion = cfg.regions.answer
    if (!answerRegion) throw new LoopAbort()

    // ---- 1) 截屏 + 同题检测 ----
    this.setState('capturing')
    let img = await this.withRetry(myToken, this.seq + 1, 'capture', () => captureRegion(answerRegion.rect, answerRegion.displayId))
    let hash = dHash(img)
    // 空白卷检测：不同空白卷画面几乎一致，哈希无法区分是否翻页，直接视为新题评分
    let blank = inkRatio(img) < BLANK_INK_RATIO
    this.consecutiveBlanks = blank ? this.consecutiveBlanks + 1 : 0
    if (blank && this.consecutiveBlanks > 30) {
      this.setState(
        'paused_notAdvanced',
        `已连续 ${this.consecutiveBlanks} 份空白卷，为防页面卡滞已自动暂停：请确认翻页正常后点「继续」`
      )
      logger.warn({ phase: 'session', detail: `连续 ${this.consecutiveBlanks} 份空白卷，自动暂停批改` })
      const r = await this.waitUser('resume')
      this.waiter = null
      this.waitKind = null
      if (r === 'stop') throw new LoopAbort()
      this.consecutiveBlanks = 0
    }
    let advancedNaturally = true
    if (!blank && isSameQuestion(hash, this.lastHash)) {
      advancedNaturally = false
      this.notAdvancedStreak++
      if (this.notAdvancedStreak >= 3) {
        // 连续 3 次未翻页：自动暂停批改，等待人工检查页面，不再倒计时自动重评
        this.setState(
          'paused_notAdvanced',
          '页面连续 3 次未翻页，已自动暂停批改：请检查阅卷页面是否能正常翻页，处理后点「继续」'
        )
        logger.warn({ phase: 'session', detail: '页面连续 3 次未翻页，自动暂停批改' })
        const r = await this.waitUser('resume')
        this.waiter = null
        this.waitKind = null
        if (r === 'stop') throw new LoopAbort()
        this.notAdvancedStreak = 0
      } else {
        this.setState(
          'paused_notAdvanced',
          `页面未翻页（连续第 ${this.notAdvancedStreak}/3 次）：5 秒后自动重评本题，点「继续」立即执行`
        )
        // 5 秒倒计时自动继续；期间点「继续」/「停止」立即生效
        const waitP = this.waitUser('resume')
        let r: unknown = 'auto'
        for (let s = 5; s > 0; s--) {
          const res = await Promise.race([sleep(1000).then(() => 'tick'), waitP])
          if (res !== 'tick') {
            r = res
            break
          }
          if (s > 1) {
            this.setState(
              'paused_notAdvanced',
              `页面未翻页（连续第 ${this.notAdvancedStreak}/3 次）：${s - 1} 秒后自动重评本题，点「继续」立即执行`
            )
          }
        }
        this.waiter = null
        this.waitKind = null
        if (r === 'stop') throw new LoopAbort()
      }
      // 自动/手动继续：视为重评当前页这一题，清除同题标记并取最新画面
      this.lastHash = undefined
      img = await this.withRetry(myToken, this.seq + 1, 'capture', () => captureRegion(answerRegion.rect, answerRegion.displayId))
      hash = dHash(img)
      blank = inkRatio(img) < BLANK_INK_RATIO
    }
    // 页面正常翻页（自然检测到新题或空白卷）时清零连续未翻页计数
    if (advancedNaturally) this.notAdvancedStreak = 0
    this.lastHash = hash

    this.seq += 1
    const seq = this.seq
    const record: QuestionRecord = {
      seq,
      sessionId: session,
      rawResponses: [],
      subScores: [],
      submitStatus: 'pending',
      usedModels: [],
      startedAt: Date.now(),
      imageHash: hash
    }
    try {
      const preview = img.resize({ width: 420 })
      record.previewDataUrl = preview.toDataURL()
    } catch {
      /* 预览失败不影响流程 */
    }
    logger.saveCapture(session, seq, img.toDataURL())
    logger.info({ phase: 'capture', seq, imgHash: hash, detail: `第 ${seq} 题截屏完成` })

    // ---- 2) 识别（模式 B/C） ----
    let ocrText: string | undefined
    if (cfg.workflow.mode !== 'A') {
      this.setState('recognizing', `正在识别第 ${seq} 题作答内容…`)
      const ocr = await this.withRetry(myToken, seq, 'ocr', () => runOcr(img, configStore.get(), seq))
      ocrText = ocr.text
      record.ocrText = ocrText
      record.usedModels.push(`识别:${ocr.provider}/${ocr.model}`)
      this.emit({ type: 'record', record: { ...record } })
    }

    // ---- 3) 评分：整题一次截屏一次评分；分小题时 AI 一次返回各小题分 ----
    const boxes = this.activeTargets(cfg)
    const subQs = boxes[0].subQ ? (boxes.map((b) => b.subQ) as SubQuestion[]) : []
    const gradingMode = cfg.workflow.gradingMode
    const grade = (ref: typeof cfg.workflow.roles.grader): Promise<GradeOutcome> =>
      runGrade({
        cfg: configStore.get(),
        subQs: subQs.length ? subQs : undefined,
        graderRef: ref,
        answerImage: configStore.get().workflow.mode === 'A' ? img : undefined,
        ocrText,
        seq
      })
    /** 从评分结果提取按 box 对齐的分数（解析失败返回 null） */
    const scoresOf = (o: GradeOutcome): number[] | null => {
      if (!o.parse.ok) return null
      if (subQs.length) return o.parse.scores?.length === subQs.length ? o.parse.scores : null
      return typeof o.parse.score === 'number' ? [o.parse.score] : null
    }
    /** 跳过本题：记失败、等翻页 */
    const skipQuestion = async (): Promise<void> => {
      record.submitStatus = 'skipped'
      record.finishedAt = Date.now()
      this.lastRecord = record
      this.stats.total += 1
      this.stats.failed += 1
      this.emit({ type: 'record', record: { ...record } })
      this.emitStats()
      this.setState('waiting_next', '本题为跳过，等待下一题…')
      await sleep(configStore.get().workflow.nextDelayMs)
    }

    this.setState('scoring', `正在评分第 ${seq} 题${subQs.length ? `（${subQs.length} 个小题）` : ''}…`)
    let a = await this.withRetry(myToken, seq, 'score', () => grade(configStore.get().workflow.roles.grader))
    let parseTries = 0
    while (!scoresOf(a) && parseTries < 2) {
      parseTries++
      a = await this.withRetry(myToken, seq, 'score', () => grade(configStore.get().workflow.roles.grader))
    }
    let scoresA = scoresOf(a)
    let finals: number[] | null = null
    let scoresB: number[] | null = null
    const arbitedFlags = boxes.map(() => false)

    if (!scoresA) {
      const manual = await this.askManualScores(seq, boxes, a)
      if (manual === 'skip') return skipQuestion()
      record.rawResponses.push(a.raw)
      finals = manual
      for (let i = 0; i < boxes.length; i++) arbitedFlags[i] = true
    } else {
      record.rawResponses.push(a.raw)
      record.usedModels.push(`评分:${a.provider}/${a.model}`)
      finals = [...scoresA]

      if (gradingMode === 'double') {
        this.setState('scoring2', `第二模型独立评分中…`)
        const grader2Ref = configStore.get().workflow.roles.grader2 ?? configStore.get().workflow.roles.grader
        let b = await this.withRetry(myToken, seq, 'score2', () => grade(grader2Ref))
        let parseTriesB = 0
        while (!scoresOf(b) && parseTriesB < 2) {
          parseTriesB++
          b = await this.withRetry(myToken, seq, 'score2', () => grade(grader2Ref))
        }
        scoresB = scoresOf(b)
        if (!scoresB) {
          const manual = await this.askManualScores(seq, boxes, b)
          if (manual === 'skip') return skipQuestion()
          record.rawResponses.push(b.raw)
          record.usedModels.push(`双评:${b.provider}/${b.model}`)
          finals = manual
          for (let i = 0; i < boxes.length; i++) arbitedFlags[i] = true
        } else {
          record.rawResponses.push(b.raw)
          record.usedModels.push(`双评:${b.provider}/${b.model}`)
          const threshold = configStore.get().workflow.doubleThreshold
          for (let i = 0; i < boxes.length; i++) {
            const diff = Math.abs(scoresA[i] - scoresB[i])
            let f: number
            let arb = false
            if (diff > threshold) {
              this.setState('arbitrating', `「${boxes[i].label}」双评分差 ${diff.toFixed(2)} 超过阈值，等待人工仲裁`)
              this.stats.arbitrated += 1
              record.scoreA = scoresA[i]
              record.scoreB = scoresB[i]
              record.arbited = true
              this.emit({ type: 'arbitrate', record: { ...record }, threshold })
              const r = await this.waitUser('arbitrate')
              if (r === 'stop') throw new LoopAbort()
              if (r === 'reject' || r === 'skip') return skipQuestion()
              f = normalizeScoreForConfig((r as { score: number }).score, configStore.get().scoreConfig, boxes[i].subQ)
              arb = true
            } else {
              f = normalizeScoreForConfig((scoresA[i] + scoresB[i]) / 2, configStore.get().scoreConfig, boxes[i].subQ)
            }
            finals[i] = f
            arbitedFlags[i] = arb
          }
        }
      }
    }

    // 汇总：小题分求和为整题得分
    boxes.forEach((b, i) => {
      record.subScores.push({
        subId: b.subQ?.id ?? 'main',
        name: b.label,
        scoreA: scoresA?.[i],
        scoreB: scoresB?.[i],
        finalScore: finals?.[i],
        arbited: arbitedFlags[i]
      })
    })
    record.finalScore = Number((finals as number[]).reduce((s, v) => s + v, 0).toFixed(2))
    if (boxes.length === 1 && boxes[0].subQ === null) {
      record.scoreA = record.subScores[0]?.scoreA
      record.scoreB = record.subScores[0]?.scoreB
      record.arbited = record.subScores[0]?.arbited
    }

    // ---- 4) 等待提交：试改需人工确认；无人值守/双评倒计时可自定义（无人默认 0 秒，双评默认 5 秒，0 = 立即提交）
    this.setState('awaiting_submit')
    let submitDecision: 'submit' | 'skip' = 'submit'
    if (gradingMode === 'trial') {
      const r = await this.waitUser('confirm')
      if (r === 'stop') throw new LoopAbort()
      if (r === 'reject' || r === 'skip') submitDecision = 'skip'
    } else {
      const waitSec =
        gradingMode === 'unattended'
          ? Math.max(0, configStore.get().workflow.unattendedDelaySec ?? 0)
          : Math.max(0, configStore.get().workflow.doubleDelaySec ?? 5)
      if (waitSec <= 0) {
        this.emit({ type: 'countdown', secondsLeft: 0 })
      } else {
        let cancelled = false
        for (let s = waitSec; s > 0 && !cancelled; s--) {
          this.emit({ type: 'countdown', secondsLeft: s })
          const r = await Promise.race([sleep(1000).then(() => 'tick'), this.waitUser('interrupt')])
          if (r === 'tick') {
            this.waiter = null
            this.waitKind = null
            continue
          }
          if (r === 'confirm') cancelled = true
          else if (r === 'reject' || r === 'skip') {
            submitDecision = 'skip'
            cancelled = true
          } else if (r === 'paused') {
            this.setState('paused_manual', '已暂停')
            const r2 = await this.waitUser('resume')
            if (r2 === 'stop') throw new LoopAbort()
            s = waitSec + 1
          } else if (r === 'stop') throw new LoopAbort()
        }
        this.emit({ type: 'countdown', secondsLeft: 0 })
      }
    }

    // ---- 5) 填分 + 提交（多分值框一次性批量填充，紧凑节奏提升效率） ----
    if (submitDecision === 'skip' || !finals) {
      await skipQuestion()
      return
    }

    this.setState('submitting', '正在填写分数并提交…')
    const entries: Array<{ region: Region; score: string }> = []
    for (let i = 0; i < boxes.length; i++) {
      const sub = boxes[i].subQ
      const boxRegion = sub?.scoreBoxId
        ? configStore.get().regions[sub.scoreBoxId]
        : configStore.get().regions.score
      if (boxRegion) entries.push({ region: boxRegion, score: String(finals[i]) })
    }
    // 分小题时若标记了整题总分框，同时填入小题分之和
    if (subQs.length && configStore.get().regions.score) {
      entries.push({ region: configStore.get().regions.score, score: String(record.finalScore) })
    }
    if (entries.length === 1) {
      await automation.fillScoreBox(entries[0].region, entries[0].score)
      logger.info({ phase: 'submit', seq, detail: `已填写分数：${entries[0].score}` })
    } else if (entries.length) {
      await automation.fillScoreBoxesBatch(entries)
      logger.info({ phase: 'submit', seq, detail: `已一次性填写 ${entries.length} 个分值框` })
    }
    const submitRegion = configStore.get().regions.submit
    if (submitRegion) await automation.clickRegion(submitRegion)
    record.submitStatus = gradingMode === 'trial' ? 'manual' : 'auto'
    record.finishedAt = Date.now()
    this.lastRecord = record
    logger.info({ phase: 'submit', seq, finalScore: record.finalScore, state: 'submitted', detail: `第 ${seq} 题已提交，得分 ${record.finalScore}` })

    this.stats.total += 1
    this.stats.submitted += 1
    if (typeof record.finalScore === 'number') {
      this.scoreSum += record.finalScore
      this.scoreCount += 1
      this.scoreMin = Math.min(this.scoreMin, record.finalScore)
      this.scoreMax = Math.max(this.scoreMax, record.finalScore)
    }
    this.emit({ type: 'record', record: { ...record } })
    this.emitStats()

    // ---- 6) 等待翻页 ----
    this.setState('waiting_next', `等待下一题（${Math.round(configStore.get().workflow.nextDelayMs / 1000)} 秒）…`)
    await sleep(configStore.get().workflow.nextDelayMs)
  }

  /** 解析失败人工兜底：按小题顺序返回各框归一化分数，或 'skip' 跳过整题 */
  private async askManualScores(
    seq: number,
    boxes: Target[],
    outcome: GradeOutcome
  ): Promise<number[] | 'skip'> {
    const multi = boxes.length > 1
    const tip = multi
      ? `第 ${seq} 题无法解析各小题给分，请按小题顺序输入 ${boxes.length} 个分数（逗号分隔，如 ${boxes.map(() => '0').join(',')}）`
      : `第 ${seq} 题无法解析模型给分，请人工给分`
    this.setState('paused_parseFailed', tip)
    logger.error({ phase: 'parse', seq, error: outcome.parse.error, rawResponse: outcome.raw.slice(0, 3000) })
    this.emit({
      type: 'error',
      message: multi
        ? `第 ${seq} 题模型输出无法解析为小题分数（${boxes.map((b) => b.label).join('、')}），请在侧边栏按顺序人工给分`
        : tip,
      recoverable: true
    })
    const r = await this.waitUser('manualScore')
    if (r === 'stop') throw new LoopAbort()
    if (r === 'reject' || r === 'skip') return 'skip'
    const arr = (r as { score: number[] }).score
    if (
      !Array.isArray(arr) ||
      arr.length !== boxes.length ||
      arr.some((v) => typeof v !== 'number' || Number.isNaN(v))
    ) {
      // 输入不合法：继续等待
      return this.askManualScores(seq, boxes, outcome)
    }
    return arr.map((v, i) => normalizeScoreForConfig(v, configStore.get().scoreConfig, boxes[i].subQ))
  }
}

export const gradingEngine = new GradingEngine()
