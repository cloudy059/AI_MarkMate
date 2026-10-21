// ============================================================
// 全局共享类型：配置 Schema / IPC / 事件（main ↔ renderer 契约）
// ============================================================

// ---------- 基础 ----------
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ---------- AI 服务商 ----------
export type ProviderKind =
  | 'qwen' // 通义千问
  | 'zhipu' // 智谱AI
  | 'doubao' // 豆包（火山方舟）
  | 'moonshot' // Kimi
  | 'deepseek'
  | 'openai'
  | 'gemini'
  | 'xfyun' // 讯飞星火
  | 'xiaomi' // 小米AI
  | 'minimax'
  | 'custom' // 任意 OpenAI 协议中转
  | 'ollama'
  | 'lmstudio'

export interface ProviderConfig {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  chatModel: string // 文本评分模型
  visionModel: string // 多模态识图/直评模型
  ocrModel: string // OCR 专用模型（可为空，空则用 visionModel）
  timeoutMs: number
  enabled: boolean
}

export type ScoreSource = 'cloud' | 'local' | 'lan'

export interface LanNode {
  id: string
  name: string
  baseUrl: string
  kind: 'ollama' | 'lmstudio' | 'openai'
  apiKey: string
  enabled: boolean
  health: { ok: boolean; rttMs: number; checkedAt: number; models: string[] }
}

/** 角色引用：批改工作流中某个环节使用的模型来源 */
export interface ProviderRef {
  source: ScoreSource
  /** cloud 来源时：ProviderConfig.id */
  providerId?: string
  /** lan 来源时：LanNode.id */
  lanNodeId?: string
  /** 覆盖默认模型（为空用 ProviderConfig 中的默认） */
  model?: string
}

// ---------- 批改工作流 ----------
/** 识别评分模式：A 多模态直评 / B 本机OCR二次评分 / C 云端OCR二次评分 */
export type RecognizeMode = 'A' | 'B' | 'C'
/** 批改控制模式 */
export type GradingMode = 'trial' | 'unattended' | 'double'

export interface DeepThinkConfig {
  enabled: boolean
  /** 1 浅 / 2 中 / 3 深 */
  level: 1 | 2 | 3
}

export interface WorkflowConfig {
  mode: RecognizeMode
  roles: {
    /** 评分模型；模式 A 下即多模态直评模型 */
    grader: ProviderRef
    /** 双评第二模型（gradingMode=double 时必填） */
    grader2: ProviderRef | null
    /** 模式 B/C 的识别（OCR）模型 */
    ocr: ProviderRef | null
  }
  gradingMode: GradingMode
  /** 无人值守模式提交前倒计时秒数（0 = 评分后立即提交） */
  unattendedDelaySec: number
  /** 双评模式提交前倒计时秒数（默认 5） */
  doubleDelaySec: number
  /** 双评分差阈值（超过则人工仲裁） */
  doubleThreshold: number
  deepThink: DeepThinkConfig
  /** 提交后等待翻页时间 ms */
  nextDelayMs: number
  /** 本轮计划批改份数（提交数达到后自动停止；0 = 不限） */
  plannedCount?: number
  /** 全局评分规则 prompt（用户自由编写） */
  rulesPrompt: string
}

// ---------- 答题区域 ----------
export type RegionKind = 'answer' | 'score' | 'submit'

export interface Region {
  id: string
  kind: RegionKind
  label: string
  displayId: number
  /** DIP 全局虚拟桌面坐标 */
  rect: Rect
  scaleAtMark: number
  /** 标记时记录的 OS 物理坐标（score/submit 点标记用，避免 DPI 换算误差） */
  phys?: { x: number; y: number }
}

/** 屏幕定位框手动调整会话的输入项 */
export interface AdjustBox {
  key: string
  label: string
  rect: Rect
}

// ---------- 分小题 ----------
export interface SubQuestion {
  id: string
  name: string
  enabled: boolean
  /** 小题分值输入框 regionId（每小题各自的输入框） */
  scoreBoxId: string | null
  maxScore: number
  minScore: number
  step: number
  /** 小题独立评分规则 */
  rulesPrompt: string
}

// ---------- 分值配置 ----------
export interface ScoreConfig {
  total: number
  min: number
  max: number
  step: number
}

// ---------- 评分标准（4+1 子页） ----------
export interface ScoringStandard {
  id: string
  name: string
  subject: string
  grade: string
  questionType: string
  /** 评分标准 */
  rubric: string
  /** 题目题干 */
  questionStem: string
  /** 参考答案 */
  referenceAnswer: string
  /** 作答要求 */
  answerRequirement: string
  /** 示例参考（文字部分） */
  sampleAnswer: string
  /** 示例参考图片（userData 相对路径） */
  sampleImages: string[]
  enabled: boolean
}

/** 4+1 子页中任意子页含文字或图片即可批改 */
export function isStandardUsable(s: ScoringStandard | null): boolean {
  if (!s) return false
  return Boolean(
    s.rubric.trim() ||
      s.questionStem.trim() ||
      s.referenceAnswer.trim() ||
      s.answerRequirement.trim() ||
      s.sampleAnswer.trim() ||
      s.sampleImages.length > 0
  )
}

// ---------- 预设方案 ----------
export interface Preset {
  id: string
  name: string
  /** 按题型/学科自动匹配规则 */
  matchRules: { questionTypes: string[]; subjects: string[] }
  /** 配置快照（workflow/scoreConfig/subQuestions/scoringStandards 相关） */
  snapshot: Partial<AppConfig>
  createdAt: number
  updatedAt: number
}

// ---------- 应用配置根 ----------
export interface AppConfig {
  version: number
  providers: ProviderConfig[]
  lanNodes: LanNode[]
  workflow: WorkflowConfig
  /** key: RegionId（answer/score/submit/sub:{id}） */
  regions: Record<string, Region>
  subQuestions: SubQuestion[]
  scoreConfig: ScoreConfig
  /** 定长 10 套评分标准预设，循环切换 */
  scoringStandards: (ScoringStandard | null)[]
  activeStandardIndex: number
  presets: Preset[]
  settings: {
    hotkeyToggle: string
    sidebarHidden: boolean
    sidebarPos: { x: number; y: number } | null
    theme: 'light' | 'dark'
    uiLanguage: 'zh-CN'
  }
  onboardingDone: boolean
}

export const CURRENT_CONFIG_VERSION = 1

// ---------- 连接测试 ----------
export interface TestResult {
  ok: boolean
  latencyMs: number
  /** 模型列表接口返回的可用模型 */
  models: string[]
  /** 最小推理探针回复摘要 */
  reply: string
  error?: string
}

// ---------- 批改事件（M→R） ----------
export type GradingState =
  | 'idle'
  | 'ready'
  | 'capturing'
  | 'recognizing'
  | 'scoring'
  | 'scoring2'
  | 'arbitrating'
  | 'awaiting_submit'
  | 'submitting'
  | 'waiting_next'
  | 'paused_sameQuestion'
  | 'paused_notAdvanced'
  | 'paused_provider'
  | 'paused_parseFailed'
  | 'paused_manual'
  | 'paused_error'

export interface SubScore {
  subId: string
  name: string
  scoreA?: number
  scoreB?: number
  finalScore?: number
  arbited?: boolean
}

export interface QuestionRecord {
  seq: number
  sessionId: string
  /** 识别文本（B/C 模式） */
  ocrText?: string
  /** 原始回复（双评时为两个模型的回复） */
  rawResponses: string[]
  scoreA?: number
  scoreB?: number
  finalScore?: number
  arbited?: boolean
  /** 分小题时各小题得分 */
  subScores: SubScore[]
  imageHash?: string
  /** 缩略预览图 dataURL（仅发送侧边栏展示，不入日志） */
  previewDataUrl?: string
  submitStatus: 'auto' | 'manual' | 'pending' | 'skipped' | 'failed'
  usedModels: string[]
  startedAt: number
  finishedAt?: number
}

export interface GradingStats {
  total: number
  submitted: number
  failed: number
  arbitrated: number
  avgScore: number
  minScore: number
  maxScore: number
  startedAt: number
}

export type GradingEvent =
  | { type: 'state'; state: GradingState; message?: string; detail?: string }
  | { type: 'countdown'; secondsLeft: number }
  | { type: 'record'; record: QuestionRecord }
  | { type: 'arbitrate'; record: QuestionRecord; threshold: number }
  | { type: 'stats'; stats: GradingStats }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'automationImpl'; impl: 'nut' | 'shell'; ok: boolean; message: string }

export interface GradingStatsPayload {
  stats: GradingStats
  state: GradingState
  lastRecord: QuestionRecord | null
}

// ---------- 日志 ----------
export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  sessionId: string
  seq: number
  /** 阶段：capture/ocr/score/parse/submit/... */
  phase: string
  provider?: string
  model?: string
  latencyMs?: number
  imgHash?: string
  ocrText?: string
  rawResponse?: string
  parsedScore?: number
  finalScore?: number
  state?: string
  error?: string
  detail?: string
}

// ---------- IPC 通道名 ----------
export const IPC = {
  // 配置
  ConfigGet: 'config:get',
  ConfigPatch: 'config:patch',
  ConfigExport: 'config:export',
  ConfigImport: 'config:import',
  // 服务商
  ProviderTest: 'providers:test',
  LanUpsert: 'lan:upsert',
  LanRemove: 'lan:remove',
  LanHealth: 'lan:health',
  LanTest: 'lan:test',
  // 区域
  RegionMark: 'regions:mark',
  RegionTest: 'regions:test',
  RegionAutoLocate: 'regions:autoLocate',
  /** 屏幕定位框手动调整（一键定位结果上屏确认） */
  RegionsAdjust: 'regions:adjust',
  // 批改
  GradingControl: 'grading:control',
  GradingEvent: 'grading:event',
  GradingStats: 'grading:stats',
  // 日志
  LogsQuery: 'logs:query',
  LogsDates: 'logs:dates',
  LogsOpenFolder: 'logs:openFolder',
  // 自动化
  AutomationCalibrate: 'automation:calibrate',
  AutomationStatus: 'automation:status',
  // 应用
  AppToggleSidebar: 'app:toggleSidebar',
  AppOpenSettings: 'app:openSettings',
  AppQuit: 'app:quit',
  AppRelaunch: 'app:relaunch',
  ExternalOpen: 'shell:openExternal',
  // 标准图片
  StandardImageAdd: 'standard:imageAdd',
  StandardImageLoad: 'standard:imageLoad',
  StandardImageSave: 'standard:imageSave',
  // AI 生成
  AiGenerateRubric: 'ai:generateRubric',
  AiImageToMarkdown: 'ai:imageToMarkdown',
  // 剪贴板
  ClipboardReadImage: 'clipboard:readImage',
  // 标记 Overlay
  OverlaySubmit: 'overlay:submit',
  OverlayCancel: 'overlay:cancel',
  OverlayInit: 'overlay:init',
  OverlayAdjustSubmit: 'overlay:adjustSubmit',
  // 设置窗口导航
  SettingsNavigate: 'settings:navigate'
} as const

/** 深度部分类型（patch 配置用；数组整体替换） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export interface AiChatMessagePart {
  type: 'text'
  text: string
}

/** 生成评分细则请求 */
export interface GenerateRubricRequest {
  grade: string // 年段
  subject: string // 学科
  questionType: string // 题型
  questionStem: string
  referenceAnswer: string
  totalScore: number
  extraRequirement?: string
}

// ---------- AI 一键定位 ----------
/** 一键定位识别出的元素框（预览图内像素坐标） */
export interface AutoLocateBoxes {
  answer?: Rect
  score?: Rect
  submit?: Rect
}

/** 一键定位结果：预览图 + 各元素框（图内像素坐标，用于确认弹窗叠加绘制） */
export interface AutoLocateResult {
  ok: boolean
  error?: string
  /** 截屏预览图（已缩放） */
  dataUrl?: string
  /** 预览图尺寸（px） */
  imgW?: number
  imgH?: number
  /** 识别出的元素框（预览图内像素坐标） */
  boxes?: AutoLocateBoxes
  /** 分小题分值框（预览图内像素坐标，按从上到下/从左到右排序） */
  subBoxes?: Rect[]
  /** 可直接保存的 Region（DIP 坐标，含分小题分值框 sub:{id}）；应用时合并进 config.regions */
  regions?: Record<string, Region>
  /** 绑定分值框后的完整 subQuestions（应用时整体替换）；未绑定任何小题时缺省 */
  subQuestions?: SubQuestion[]
  /** 成功绑定的小题数 */
  subBound?: number
  /** 小题为本次自动创建（未配置小题但检测到多个分数输入框） */
  subAutoCreated?: boolean
  /** 分小题场景：平台提交小题分后自动累计总分，应用时移除整题总分框 */
  dropScore?: boolean
  /** 未识别到的元素中文名 */
  missing?: string[]
  /** 提示信息（如使用的模型） */
  note?: string
}
