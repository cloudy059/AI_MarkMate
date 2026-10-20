import { app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { LogEntry } from '@shared/types'
import { genId } from '@main/utils'

type LogInput = Partial<Omit<LogEntry, 'ts' | 'sessionId'>> & { phase: string }

/** JSONL 按天分文件的全链路日志 */
class Logger {
  private dir = ''
  sessionId = genId('sess')

  init(): void {
    this.dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(this.dir, { recursive: true })
    this.cleanOld(30)
  }

  newSession(): string {
    this.sessionId = genId('sess')
    return this.sessionId
  }

  log(input: LogInput): void {
    if (!this.dir) return
    const entry: LogEntry = {
      ts: Date.now(),
      level: input.level ?? 'info',
      sessionId: this.sessionId,
      seq: input.seq ?? 0,
      ...input
    }
    try {
      const file = path.join(this.dir, `${this.dateStr(new Date(entry.ts))}.jsonl`)
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf-8')
    } catch (err) {
      console.error('[logger] 写入失败', err)
    }
  }

  info(input: LogInput): void {
    this.log({ ...input, level: 'info' })
  }
  warn(input: LogInput): void {
    this.log({ ...input, level: 'warn' })
  }
  error(input: LogInput): void {
    this.log({ ...input, level: 'error' })
  }

  query(date?: string, sessionId?: string, level?: LogEntry['level']): LogEntry[] {
    if (!this.dir) return []
    const dates = date ? [date] : fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort().slice(-7) : []
    const out: LogEntry[] = []
    for (const d of dates) {
      try {
        const lines = fs.readFileSync(path.join(this.dir, `${d}.jsonl`), 'utf-8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as LogEntry
            if (sessionId && e.sessionId !== sessionId) continue
            if (level && e.level !== level) continue
            out.push(e)
          } catch {
            /* 跳过损坏行 */
          }
        }
      } catch {
        /* 跳过缺失文件 */
      }
    }
    return out
  }

  listDates(): string[] {
    if (!this.dir || !fs.existsSync(this.dir)) return []
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', '')).sort().reverse()
  }

  openFolder(): Promise<string> {
    return shell.openPath(this.dir)
  }

  /** 题目截图目录（按会话） */
  capturesDir(sessionId: string): string {
    const dir = path.join(app.getPath('userData'), 'captures', sessionId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  saveCapture(sessionId: string, seq: number, dataUrl: string): string | null {
    try {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      const file = path.join(this.capturesDir(sessionId), `q${seq}.png`)
      fs.writeFileSync(file, Buffer.from(base64, 'base64'))
      return file
    } catch {
      return null
    }
  }

  capturePath(sessionId: string, seq: number): string {
    return path.join(app.getPath('userData'), 'captures', sessionId, `q${seq}.png`)
  }

  private dateStr(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  private cleanOld(days: number): void {
    try {
      const cutoff = Date.now() - days * 24 * 3600 * 1000
      for (const f of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, f)
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
      }
      const capRoot = path.join(app.getPath('userData'), 'captures')
      if (fs.existsSync(capRoot)) {
        for (const d of fs.readdirSync(capRoot)) {
          const full = path.join(capRoot, d)
          if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true })
        }
      }
    } catch {
      /* 忽略清理失败 */
    }
  }
}

export const logger = new Logger()
