import type {
  AppConfig,
  AdjustBox,
  AutoLocateResult,
  CorrectionAnalyzeRequest,
  CorrectionAnalysisSections,
  CorrectionInitPayload,
  CorrectionStreamEvent,
  DeepPartial,
  GenerateRubricRequest,
  GradingEvent,
  GradingStatsPayload,
  LanNode,
  LogEntry,
  ProviderConfig,
  QuestionRecord,
  Rect,
  Region,
  RegionKind,
  ScoringStandard,
  TestResult
} from './types'

/** preload 暴露给渲染进程的类型化 API（window.api） */
export interface Api {
  // ----- 配置 -----
  getConfig(): Promise<AppConfig>
  patchConfig(p: DeepPartial<AppConfig> | Record<string, unknown>): Promise<AppConfig>
  exportConfig(): Promise<string | null>
  importConfig(): Promise<AppConfig | null>

  // ----- 服务商 / 局域网节点 -----
  testProvider(providerId: string): Promise<TestResult>
  testLanNode(node: LanNode): Promise<TestResult>
  upsertLanNode(node: LanNode): Promise<AppConfig>
  removeLanNode(id: string): Promise<AppConfig>
  checkLanHealth(): Promise<LanNode[]>

  // ----- 答题区域 -----
  markRegion(target: { kind: RegionKind; id?: string; label?: string }): Promise<Region | null>
  testRegionCapture(regionId: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  /** AI 一键定位：截屏识别答题区域/分值输入框/提交按钮 */
  autoLocateRegions(): Promise<AutoLocateResult>
  /** 屏幕上显示定位框供手动拖动调整；确认返回调整后的 rects（全局 DIP），取消返回 null */
  adjustRegionBoxes(boxes: AdjustBox[]): Promise<Record<string, Rect> | null>

  // ----- 批改控制 -----
  gradingControl(action: string, value?: unknown): Promise<{ ok: boolean; message?: string }>
  getGradingStats(): Promise<GradingStatsPayload>
  onGradingEvent(cb: (e: GradingEvent) => void): () => void

  // ----- 阅卷后答题分析 -----
  /** 生成本场批改的答题情况分析报告（Markdown 全文） */
  generateAnalysis(): Promise<string>
  /** 导出分析报告为 Markdown 文件（返回保存路径，取消返回 null） */
  exportAnalysis(markdown: string): Promise<string | null>

  // ----- 日志 -----
  queryLogs(opts: { date?: string; sessionId?: string }): Promise<LogEntry[]>
  listLogDates(): Promise<string[]>
  openLogsFolder(): Promise<void>

  // ----- 自动化 -----
  calibrateAutomation(): Promise<{ impl: string; ok: boolean; message: string }>
  getAutomationStatus(): Promise<{ impl: string; ok: boolean; message: string }>

  // ----- 应用 -----
  toggleSidebar(): void
  openSettings(page?: string): void
  quitApp(): void
  relaunchApp(): void
  /** 用系统默认浏览器打开外部链接（服务商 API 控制台等，仅允许 http/https） */
  openExternal(url: string): void
  onNavigate(cb: (page: string) => void): () => void

  // ----- 评分标准图片 -----
  addStandardImage(standardId: string): Promise<string[]>
  loadStandardImage(relPath: string): Promise<string>
  /** 保存粘贴的截图到标准图片目录，返回相对路径（用于嵌入 Markdown） */
  saveStandardImage(dataUrl: string): Promise<string>

  // ----- AI 生成评分细则 -----
  generateRubric(req: GenerateRubricRequest): Promise<string>
  /** 读取剪贴板中的图片（无图片返回 null） */
  readClipboardImage(): Promise<{ dataUrl: string } | null>
  /** AI 将截图内容转写为 Markdown（公式用 LaTeX） */
  imageToMarkdown(dataUrl: string): Promise<string>

  // ----- 标记 Overlay（仅 overlay 页面调用） -----
  overlaySubmit(payload: { rect?: Rect; point?: { x: number; y: number } }): void
  overlayCancel(): void
  overlayAdjustSubmit(map: Record<string, Rect>): void
  /** 调整层数据推送（主进程 → overlay 渲染层）；preload 内置缓存，先到后注册不丢消息 */
  onOverlayInit(cb: (data: { bounds: { x: number; y: number; width: number; height: number }; boxes: AdjustBox[] }) => void): void

  // ----- AI 纠错（仅 correction 窗口调用） -----
  /** 启动 AI 差异分析（流式，经 onCorrectionStream 推送增量） */
  correctionAnalyze(req: CorrectionAnalyzeRequest): Promise<{ ok: boolean; sections?: CorrectionAnalysisSections; error?: string }>
  /** AI 润色评分理由（流式，经 onCorrectionStream 推送增量） */
  correctionPolish(text: string, record: QuestionRecord): Promise<{ ok: boolean; text?: string; error?: string }>
  /** 纠错面板初始化数据（主进程推送；preload 内置缓存） */
  onCorrectionInit(cb: (data: CorrectionInitPayload) => void): void
  /** 分析/润色流式增量 */
  onCorrectionStream(cb: (e: CorrectionStreamEvent) => void): () => void
  /** 关闭纠错窗口 */
  closeCorrection(): void
}
