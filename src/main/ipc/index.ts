import { BrowserWindow, clipboard, dialog, app, nativeImage, shell, ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  IPC,
  type AdjustBox,
  type AppConfig,
  type CorrectionAnalyzeRequest,
  type GenerateRubricRequest,
  type LanNode,
  type LogEntry,
  type RegionKind
} from '@shared/types'
import { configStore } from '@main/services/config-store'
import { logger } from '@main/services/logger'
import { automation } from '@main/services/automation'
import { lanBalancer } from '@main/ai/lan-balancer'
import { testLanNode, testProvider } from '@main/ai/connection-test'
import { resolveProviderRef } from '@main/ai/resolve'
import { buildThinkingParams } from '@main/ai/registry'
import { autoLocateRegions } from '@main/ai/auto-locate'
import { captureRegion } from '@main/services/screenshot'
import { gradingEngine, type ControlAction } from '@main/grading/state-machine'
import { runCorrectionAnalysis, runReasonPolish } from '@main/grading/correction'
import {
  closeCorrectionWindow,
  handleOverlayCancel,
  handleOverlaySubmit,
  handleOverlayAdjustSubmit,
  adjustRegionBoxes,
  markRegion,
  openSettings,
  toggleSidebar
} from '@main/windows'
import { genId } from '@main/utils'
import { applyHotkey } from '@main/hotkey'

function register(key: string, handler: (e: IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(key, handler as any)
}

/** 统一错误包装：把异常消息返回给渲染进程 */
function safe<A extends any[], R>(fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R | { __error: string }> {
  return async (...args: A) => {
    try {
      return await fn(...args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ phase: 'ipc', error: msg })
      return { __error: msg }
    }
  }
}

export function registerIpc(): void {
  // ---------------- 配置 ----------------
  register(IPC.ConfigGet, () => configStore.get())
  register(IPC.ConfigPatch, (_e, partial: Record<string, unknown>) => {
    const before = configStore.get()
    const cfg = configStore.patch(partial)
    const newHotkey = (partial as { settings?: { hotkeyToggle?: string } })?.settings?.hotkeyToggle
    if (typeof newHotkey === 'string' && newHotkey !== before.settings.hotkeyToggle) {
      applyHotkey(newHotkey)
    }
    return cfg
  })
  register(
    IPC.ConfigExport,
    safe(async () => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出全部配置',
        defaultPath: `ai-grading-config-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (canceled || !filePath) return null
      fs.writeFileSync(filePath, JSON.stringify(configStore.get(), null, 2), 'utf-8')
      return filePath
    })
  )
  register(
    IPC.ConfigImport,
    safe(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入配置',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (canceled || !filePaths.length) return null
      const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8')) as AppConfig
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.providers)) throw new Error('文件格式不正确')
      return configStore.replace(raw)
    })
  )

  // ---------------- 服务商 / 局域网 ----------------
  register(
    IPC.ProviderTest,
    safe(async (_e, providerId: string) => {
      const p = configStore.get().providers.find((x) => x.id === providerId)
      if (!p) throw new Error('未找到该服务商')
      return testProvider(p)
    })
  )
  register(IPC.LanTest, safe((_e, node: LanNode) => testLanNode(node)))
  register(
    IPC.LanUpsert,
    safe((_e, node: LanNode) => {
      const cfg = configStore.get()
      const idx = cfg.lanNodes.findIndex((n) => n.id === node.id)
      const next = idx >= 0 ? cfg.lanNodes.map((n, i) => (i === idx ? node : n)) : [...cfg.lanNodes, node]
      return configStore.patch({ lanNodes: next })
    })
  )
  register(
    IPC.LanRemove,
    safe((_e, id: string) => {
      const cfg = configStore.get()
      return configStore.patch({ lanNodes: cfg.lanNodes.filter((n) => n.id !== id) })
    })
  )
  register(IPC.LanHealth, safe(() => lanBalancer.checkAll()))

  // ---------------- 答题区域 ----------------
  register(
    IPC.RegionMark,
    safe(async (_e, target: { kind: RegionKind; id?: string; label?: string }) => {
      const region = await markRegion(target)
      if (region) {
        const cfg = configStore.get()
        const regions = { ...cfg.regions, [region.id]: region }
        // 标记的是子题分值框/子题答题区域时，同时移除旧的同 id 区域（覆盖语义）
        configStore.patch({ regions })
        logger.info({ phase: 'region', detail: `标记「${region.label}」: (${region.rect.x},${region.rect.y},${region.rect.w}×${region.rect.h}) DPI=${region.scaleAtMark}` })
      }
      return region
    })
  )
  register(
    IPC.RegionTest,
    safe(async (_e, regionId: string) => {
      const region = configStore.get().regions[regionId]
      if (!region) return { ok: false, error: '该区域尚未标记' }
      const img = await captureRegion(region.rect, region.displayId)
      return { ok: true, dataUrl: img.resize({ width: 640 }).toDataURL() }
    })
  )

  // ---------------- AI 一键定位 ----------------
  register(IPC.RegionAutoLocate, safe(() => autoLocateRegions()))

  // ---------------- 批改控制 ----------------
  register(IPC.GradingControl, (_e, action: string, value?: unknown) =>
    gradingEngine.control(action as ControlAction, value)
  )
  register(IPC.GradingStats, () => gradingEngine.getStats())

  // ---------------- 日志 ----------------
  register(IPC.LogsQuery, (_e, opts: { date?: string; sessionId?: string }) =>
    logger.query(opts?.date, opts?.sessionId)
  )
  register(IPC.LogsDates, () => logger.listDates())
  register(IPC.LogsOpenFolder, () => logger.openFolder())

  // ---------------- 自动化 ----------------
  register(IPC.AutomationCalibrate, safe(() => automation.calibrate()))
  register(IPC.AutomationStatus, () => automation.getStatus())

  // ---------------- 应用 ----------------
  register(IPC.AppToggleSidebar, () => toggleSidebar())
  register(IPC.AppOpenSettings, (_e, page?: string) => {
    openSettings(page)
    return true
  })
  register(IPC.AppQuit, () => {
    configStore.saveNow()
    app.quit()
  })
  register(IPC.AppRelaunch, () => {
    configStore.saveNow()
    app.relaunch()
    app.quit()
  })
  register(IPC.ExternalOpen, (_e, url: string) => {
    // 仅放行 http/https，避免任意协议被渲染进程唤起
    if (!/^https?:\/\//i.test(url)) return false
    return shell.openExternal(url)
  })

  // ---------------- 评分标准图片 ----------------
  register(
    IPC.StandardImageAdd,
    safe(async (_e, standardId: string) => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择评分参考图片',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] }],
        properties: ['openFile', 'multiSelections']
      })
      if (canceled || !filePaths.length) return []
      const dir = path.join(app.getPath('userData'), 'standards', standardId)
      fs.mkdirSync(dir, { recursive: true })
      const relPaths: string[] = []
      for (const f of filePaths.slice(0, 6)) {
        const img = nativeImage.createFromPath(f)
        if (img.isEmpty()) continue
        const sized = img.getSize().width > 1600 ? img.resize({ width: 1600 }) : img
        const rel = `${standardId}/${genId('img')}.png`
        fs.writeFileSync(path.join(app.getPath('userData'), 'standards', rel), sized.toPNG())
        relPaths.push(rel)
      }
      return relPaths
    })
  )
  register(
    IPC.StandardImageLoad,
    safe((_e, relPath: string) => {
      const full = path.join(app.getPath('userData'), 'standards', relPath)
      if (!fs.existsSync(full)) throw new Error('图片不存在')
      const img = nativeImage.createFromPath(full)
      if (img.isEmpty()) throw new Error('图片读取失败')
      return img.toDataURL()
    })
  )
  register(
    IPC.StandardImageSave,
    safe((_e, dataUrl: string) => {
      const img = nativeImage.createFromDataURL(dataUrl)
      if (img.isEmpty()) throw new Error('图片数据无效')
      const sized = img.getSize().width > 1600 ? img.resize({ width: 1600 }) : img
      const dir = path.join(app.getPath('userData'), 'standards', 'paste')
      fs.mkdirSync(dir, { recursive: true })
      const rel = `paste/${genId('img')}.png`
      fs.writeFileSync(path.join(app.getPath('userData'), 'standards', rel), sized.toPNG())
      return rel
    })
  )

  // ---------------- AI 生成评分细则 ----------------
  register(
    IPC.AiGenerateRubric,
    safe(async (_e, req: GenerateRubricRequest) => {
      const cfg = configStore.get()
      const target = resolveProviderRef(cfg.workflow.roles.grader, 'chat')
      const think = buildThinkingParams(target.providerKind ?? 'custom')
      const model = think.modelOverride ?? target.model
      const lines = [
        '你是一位资深教研专家，擅长制定严谨、可操作的评分细则。',
        '',
        '请根据以下信息起草一份评分细则（评分标准），要求：',
        '1. 使用 Markdown 格式',
        '2. 先给出总体评分原则，再按得分点/分档列出细则（明确每个档次的分数区间与判定条件）',
        '3. 列出常见扣分点与宽容处理建议（如错别字、格式、单位等）',
        '4. 数学公式用 LaTeX 表示',
        '5. 内容具体、可执行，AI 批卷时可直接对照执行',
        '',
        `【年段】${req.grade}`,
        `【学科】${req.subject}`,
        `【题型】${req.questionType}`,
        `【满分】${req.totalScore} 分`,
        req.questionStem.trim() ? `【题目题干】\n${req.questionStem}` : '',
        req.referenceAnswer.trim() ? `【参考答案】\n${req.referenceAnswer}` : '',
        req.extraRequirement?.trim() ? `【其他要求】\n${req.extraRequirement}` : '',
        '',
        '请直接输出评分细则正文，不要额外说明。'
      ]
      const res = await target.adapter.chat({
        model,
        system: '你是命题与评价专家，输出为结构清晰的 Markdown 评分细则。',
        prompt: lines.filter(Boolean).join('\n'),
        timeoutMs: target.timeoutMs,
        extra: think.extra
      })
      logger.info({ phase: 'rubric', provider: target.name, model, latencyMs: res.latencyMs, detail: 'AI 生成评分细则' })
      return res.text
    })
  )

  // ---------------- 剪贴板读图 ----------------
  register(
    IPC.ClipboardReadImage,
    safe(async () => {
      // Electron 44：clipboard.readImage 已移除，改用 W3C 风格 read() → ClipboardItem
      const items = await clipboard.read()
      for (const it of items) {
        const imgType = it.types.find((t) => t.startsWith('image/'))
        if (!imgType) continue
        try {
          const payload = await it.getType(imgType)
          if (!('arrayBuffer' in payload)) continue
          const buf = Buffer.from(await payload.arrayBuffer())
          if (!buf.length) continue
          const b64 = buf.toString('base64')
          return { dataUrl: `data:${imgType};base64,${b64}` }
        } catch {
          /* 该项不含图片，继续 */
        }
      }
      return null
    })
  )

  // ---------------- AI 截图转 Markdown ----------------
  register(
    IPC.AiImageToMarkdown,
    safe(async (_e, dataUrl: string) => {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('无效的图片数据')
      }
      const cfg = configStore.get()
      // 优先使用识别（OCR）角色；模式 A 下未配置时回退评分模型的视觉模型
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
        system:
          '你是专业的文档转录助手。将图片中的内容精确转写为 Markdown：\n' +
          '1. 数学公式一律用 LaTeX 表示（行内 $...$、独立公式 $$...$$）\n' +
          '2. 保持原有层级结构，用标题、有序/无序列表组织内容\n' +
          '3. 表格用 Markdown 表格语法\n' +
          '4. 直接输出正文本身，不要添加任何解释、前言或代码围栏',
        prompt: '请把这张图片中的全部内容完整转写为 Markdown 文本（公式用 LaTeX），不要遗漏任何文字。',
        imageDataUrls: [dataUrl],
        timeoutMs: target.timeoutMs,
        extra: think.extra
      })
      logger.info({
        phase: 'docOcr',
        provider: target.name,
        model,
        latencyMs: res.latencyMs,
        detail: `截图转 Markdown：${res.text.length} 字`
      })
      return res.text
    })
  )

  // ---------------- AI 纠错面板 ----------------
  register(
    IPC.CorrectionAnalyze,
    safe(async (e: IpcMainInvokeEvent, req: CorrectionAnalyzeRequest) => {
      if (!req || !req.record || !Array.isArray(req.teacherScores)) throw new Error('纠错分析参数不完整')
      const sender = e.sender
      const { sections } = await runCorrectionAnalysis(req, (delta) => {
        if (!sender.isDestroyed()) sender.send(IPC.CorrectionStream, { kind: 'analyze', delta })
      })
      return { ok: true, sections }
    })
  )
  register(
    IPC.CorrectionPolish,
    safe(async (e: IpcMainInvokeEvent, text: string, record: { seq?: number }) => {
      if (typeof text !== 'string' || !text.trim()) throw new Error('无评分理由可润色')
      const sender = e.sender
      const out = await runReasonPolish(text, record?.seq ?? 0, (delta) => {
        if (!sender.isDestroyed()) sender.send(IPC.CorrectionStream, { kind: 'polish', delta })
      })
      return { ok: true, text: out }
    })
  )
  register(IPC.CorrectionClose, () => {
    const wasAwaiting = gradingEngine.getState() === 'awaiting_submit'
    closeCorrectionWindow()
    if (wasAwaiting) gradingEngine.notifyCorrectionClosed()
    return true
  })

  // ---------------- Overlay ----------------
  register(IPC.OverlaySubmit, (e: IpcMainInvokeEvent, payload: { rect?: unknown; point?: unknown }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) void handleOverlaySubmit(win, payload as { rect?: any; point?: any })
    return true
  })
  register(IPC.OverlayCancel, () => {
    handleOverlayCancel()
    return true
  })
  register(IPC.OverlayAdjustSubmit, (e: IpcMainInvokeEvent, map: Record<string, unknown>) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) handleOverlayAdjustSubmit(win, map as never)
    return true
  })

  // ---------------- 屏幕定位框手动调整 ----------------
  register(IPC.RegionsAdjust, (_e: IpcMainInvokeEvent, boxes: AdjustBox[]) => adjustRegionBoxes(boxes))
}
