import { create } from 'zustand'
import { message } from 'antd'
import type { GradingEvent, GradingState, GradingStats, QuestionRecord } from '@shared/types'

interface GradingStore {
  state: GradingState
  message: string
  countdown: number
  stats: GradingStats | null
  lastRecord: QuestionRecord | null
  arbitrate: { record: QuestionRecord; threshold: number } | null
  autoImpl: { impl: 'nut' | 'shell'; ok: boolean; message: string } | null
  init: () => void
  control: (action: string, value?: unknown) => Promise<{ ok: boolean; message?: string }>
}

let inited = false

/** 批改运行时仓库：订阅主进程事件流，维护状态/倒计时/统计/最近记录/仲裁 */
export const useGradingStore = create<GradingStore>((set) => ({
  state: 'idle',
  message: '',
  countdown: 0,
  stats: null,
  lastRecord: null,
  arbitrate: null,
  autoImpl: null,

  init: () => {
    if (inited) return
    inited = true
    void window.api.getGradingStats().then((p) => {
      set({ state: p.state, stats: p.stats, lastRecord: p.lastRecord })
    })
    window.api.onGradingEvent((e: GradingEvent) => {
      switch (e.type) {
        case 'state':
          set({ state: e.state, message: e.message ?? '', countdown: 0 })
          if (e.state === 'awaiting_submit') set({ arbitrate: null })
          break
        case 'countdown':
          set({ countdown: e.secondsLeft })
          break
        case 'record':
          set({ lastRecord: e.record })
          break
        case 'arbitrate':
          set({ arbitrate: { record: e.record, threshold: e.threshold } })
          break
        case 'stats':
          set({ stats: e.stats })
          break
        case 'error':
          if (e.recoverable) void message.error(e.message)
          else void message.warning(e.message)
          break
        case 'automationImpl':
          set({ autoImpl: { impl: e.impl, ok: e.ok, message: e.message } })
          if (!e.ok) void message.warning(`键鼠自动化：${e.message}`)
          break
      }
    })
  },

  control: (action, value) => window.api.gradingControl(action, value)
}))
