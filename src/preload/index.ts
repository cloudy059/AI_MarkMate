import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type { Api } from '@shared/api'

const api: Api = {
  getConfig: () => ipcRenderer.invoke(IPC.ConfigGet),
  patchConfig: (p) => ipcRenderer.invoke(IPC.ConfigPatch, p),
  exportConfig: () => ipcRenderer.invoke(IPC.ConfigExport),
  importConfig: () => ipcRenderer.invoke(IPC.ConfigImport),

  testProvider: (providerId) => ipcRenderer.invoke(IPC.ProviderTest, providerId),
  testLanNode: (node) => ipcRenderer.invoke(IPC.LanTest, node),
  upsertLanNode: (node) => ipcRenderer.invoke(IPC.LanUpsert, node),
  removeLanNode: (id) => ipcRenderer.invoke(IPC.LanRemove, id),
  checkLanHealth: () => ipcRenderer.invoke(IPC.LanHealth),

  markRegion: (target) => ipcRenderer.invoke(IPC.RegionMark, target),
  testRegionCapture: (regionId) => ipcRenderer.invoke(IPC.RegionTest, regionId),
  autoLocateRegions: () => ipcRenderer.invoke(IPC.RegionAutoLocate),
  adjustRegionBoxes: (boxes) => ipcRenderer.invoke(IPC.RegionsAdjust, boxes),

  gradingControl: (action, value) => ipcRenderer.invoke(IPC.GradingControl, action, value),
  getGradingStats: () => ipcRenderer.invoke(IPC.GradingStats),
  generateAnalysis: () => ipcRenderer.invoke(IPC.AnalysisGenerate),
  exportAnalysis: (markdown) => ipcRenderer.invoke(IPC.AnalysisExport, markdown),
  onGradingEvent: (cb) => {
    const handler = (_e: unknown, ev: Parameters<typeof cb>[0]) => cb(ev)
    ipcRenderer.on(IPC.GradingEvent, handler as never)
    return () => {
      ipcRenderer.removeListener(IPC.GradingEvent, handler as never)
    }
  },

  queryLogs: (opts) => ipcRenderer.invoke(IPC.LogsQuery, opts),
  listLogDates: () => ipcRenderer.invoke(IPC.LogsDates),
  openLogsFolder: () => ipcRenderer.invoke(IPC.LogsOpenFolder),

  calibrateAutomation: () => ipcRenderer.invoke(IPC.AutomationCalibrate),
  getAutomationStatus: () => ipcRenderer.invoke(IPC.AutomationStatus),

  toggleSidebar: () => {
    void ipcRenderer.invoke(IPC.AppToggleSidebar)
  },
  openSettings: (page) => {
    void ipcRenderer.invoke(IPC.AppOpenSettings, page)
  },
  quitApp: () => {
    void ipcRenderer.invoke(IPC.AppQuit)
  },
  relaunchApp: () => {
    void ipcRenderer.invoke(IPC.AppRelaunch)
  },
  openExternal: (url) => {
    void ipcRenderer.invoke(IPC.ExternalOpen, url)
  },
  onNavigate: (cb) => {
    const handler = (_e: unknown, page: string) => cb(page)
    ipcRenderer.on(IPC.SettingsNavigate, handler as never)
    return () => {
      ipcRenderer.removeListener(IPC.SettingsNavigate, handler as never)
    }
  },

  addStandardImage: (standardId) => ipcRenderer.invoke(IPC.StandardImageAdd, standardId),
  loadStandardImage: (relPath) => ipcRenderer.invoke(IPC.StandardImageLoad, relPath),
  saveStandardImage: (dataUrl) => ipcRenderer.invoke(IPC.StandardImageSave, dataUrl),

  generateRubric: (req) => ipcRenderer.invoke(IPC.AiGenerateRubric, req),
  readClipboardImage: () => ipcRenderer.invoke(IPC.ClipboardReadImage),
  imageToMarkdown: (dataUrl) => ipcRenderer.invoke(IPC.AiImageToMarkdown, dataUrl),

  overlaySubmit: (payload) => {
    void ipcRenderer.invoke(IPC.OverlaySubmit, payload)
  },
  overlayCancel: () => {
    void ipcRenderer.invoke(IPC.OverlayCancel)
  },
  overlayAdjustSubmit: (map) => {
    void ipcRenderer.invoke(IPC.OverlayAdjustSubmit, map)
  },
  onOverlayInit: (cb) => {
    overlayInitCb = cb as ((d: unknown) => void) | null
    if (overlayInitData !== null) cb(overlayInitData as never)
  },

  correctionAnalyze: (req) => ipcRenderer.invoke(IPC.CorrectionAnalyze, req),
  correctionPolish: (text, record) => ipcRenderer.invoke(IPC.CorrectionPolish, text, record),
  onCorrectionInit: (cb) => {
    correctionInitCb = cb as ((d: unknown) => void) | null
    if (correctionInitData !== null) cb(correctionInitData as never)
  },
  onCorrectionStream: (cb) => {
    const handler = (_e: unknown, ev: Parameters<typeof cb>[0]) => cb(ev)
    ipcRenderer.on(IPC.CorrectionStream, handler as never)
    return () => {
      ipcRenderer.removeListener(IPC.CorrectionStream, handler as never)
    }
  },
  closeCorrection: () => {
    void ipcRenderer.invoke(IPC.CorrectionClose)
  }
}

// overlay:init 消息缓存：消息先于渲染层注册监听到达时不丢失
let overlayInitData: unknown = null
let overlayInitCb: ((d: unknown) => void) | null = null
ipcRenderer.on(IPC.OverlayInit, (_e, data) => {
  overlayInitData = data
  overlayInitCb?.(data)
})

// correction:init 消息缓存：同上，新建窗口时 init 可能在渲染层就绪前推送
let correctionInitData: unknown = null
let correctionInitCb: ((d: unknown) => void) | null = null
ipcRenderer.on(IPC.CorrectionInit, (_e, data) => {
  correctionInitData = data
  correctionInitCb?.(data)
})

contextBridge.exposeInMainWorld('api', api)
