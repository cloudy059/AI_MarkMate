import { create } from 'zustand'
import type { AppConfig, DeepPartial } from '@shared/types'

interface ConfigState {
  config: AppConfig | null
  load: () => Promise<AppConfig>
  patch: (p: DeepPartial<AppConfig> | Record<string, unknown>) => Promise<AppConfig>
}

/** 全局配置仓库：主进程持久化后的配置在渲染层的唯一镜像 */
export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  load: async () => {
    const cfg = await window.api.getConfig()
    set({ config: cfg })
    return cfg
  },
  patch: async (p) => {
    const cfg = await window.api.patchConfig(p)
    set({ config: cfg })
    return cfg
  }
}))
