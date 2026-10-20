/** 自动化实现统一接口（实现A：nut-js；实现B：系统脚本） */
export interface IAutomation {
  readonly impl: 'nut' | 'shell'
  /** 可用性探针 */
  probe(): Promise<boolean>
  /** 当前鼠标位置（OS 坐标：Windows=物理像素 / macOS=点坐标） */
  getMousePos(): Promise<{ x: number; y: number }>
  click(x: number, y: number): Promise<void>
  /** 敲键：key 为 'enter'/'tab'/'esc'/'v'/'a' 等虚拟键名 */
  keyTap(key: string, modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>): Promise<void>
  /** 逐字符输入（纯文本，用于粘贴降级） */
  typeText(text: string): Promise<void>
}

export const VKEY_CODES: Record<string, number> = {
  // Windows 虚拟键码（shell 实现用）
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  esc: 0x1b,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  ctrl: 0x11,
  a: 0x41,
  c: 0x43,
  v: 0x56,
  x: 0x58,
  f5: 0x74
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
