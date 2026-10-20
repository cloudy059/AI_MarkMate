import { useEffect, useRef, useState } from 'react'
import type { AdjustBox, Rect } from '@shared/types'

/** 从窗口 URL 参数解析模式（主进程创建窗口时注入） */
function target(): { kind: string; label: string } {
  const q = new URLSearchParams(window.location.search)
  return { kind: q.get('kind') ?? 'answer', label: decodeURIComponent(q.get('label') ?? '答题区域') }
}

export default function App() {
  const { kind, label } = target()
  if (kind === 'adjust') return <AdjustLayer />
  return <MarkLayer kind={kind} label={label} />
}

/**
 * 全屏透明标记层：
 * - kind=answer → 按住左键拖拽矩形，松开提交 rect
 * - kind=score / submit → 左键单击标记位置，提交 point
 * - ESC 任意时刻取消
 */
function MarkLayer({ kind, label }: { kind: string; label: string }) {
  const isRect = kind === 'answer'
  const [sel, setSel] = useState<Rect | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  // ESC 取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.api.overlayCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 矩形框选模式
  useEffect(() => {
    if (!isRect) return
    const down = (e: MouseEvent) => {
      if (e.button === 0) startRef.current = { x: e.clientX, y: e.clientY }
    }
    const move = (e: MouseEvent) => {
      const s = startRef.current
      if (!s) return
      setPos({ x: e.clientX, y: e.clientY })
      setSel({
        x: Math.min(s.x, e.clientX),
        y: Math.min(s.y, e.clientY),
        w: Math.abs(e.clientX - s.x),
        h: Math.abs(e.clientY - s.y)
      })
    }
    const up = (e: MouseEvent) => {
      const s = startRef.current
      startRef.current = null
      if (!s) return
      const rect: Rect = {
        x: Math.min(s.x, e.clientX),
        y: Math.min(s.y, e.clientY),
        w: Math.abs(e.clientX - s.x),
        h: Math.abs(e.clientY - s.y)
      }
      if (rect.w >= 8 && rect.h >= 8) {
        window.api.overlaySubmit({ rect })
      } else {
        setSel(null)
      }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [isRect])

  // 单点标记模式（忽略微小拖动）
  useEffect(() => {
    if (isRect) return
    const down = (e: MouseEvent) => {
      if (e.button === 0) startRef.current = { x: e.clientX, y: e.clientY }
    }
    const move = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY })
    const up = (e: MouseEvent) => {
      const s = startRef.current
      startRef.current = null
      if (!s || e.button !== 0) return
      if (Math.abs(e.clientX - s.x) > 6 || Math.abs(e.clientY - s.y) > 6) return
      window.api.overlaySubmit({ point: { x: e.clientX, y: e.clientY } })
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [isRect])

  return (
    <div className="overlay-root">
      <div className="hint-bar">
        {isRect ? (
          <>
            请按住鼠标左键，在屏幕上框选「{label}」，松开完成标记
            <br />
            按 <span className="kbd">ESC</span> 取消
          </>
        ) : (
          <>
            请用鼠标左键点击「{label}」所在的位置完成标记
            <br />
            按 <span className="kbd">ESC</span> 取消
          </>
        )}
      </div>
      {isRect && sel && (
        <div
          className="sel-box"
          style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
        >
          <span className="sel-size">
            {Math.round(sel.w)} × {Math.round(sel.h)}
          </span>
        </div>
      )}
      {!isRect && pos && <div className="point-ghost" style={{ left: pos.x, top: pos.y }} />}
    </div>
  )
}

/** 框配色：答题区域蓝 / 分值框绿 / 提交按钮橙 / 小题分值框青 */
function boxColor(key: string): string {
  if (key === 'answer') return '#1677ff'
  if (key === 'score') return '#52c41a'
  if (key === 'submit') return '#fa8c16'
  return '#13c2c2'
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const

/**
 * 定位框手动调整层：在屏幕元素上显示 AI 定位结果，
 * 拖动框体移动、拖动白色圆点调整大小（所有框均支持），确认后保存。
 */
function AdjustLayer() {
  const [boxes, setBoxes] = useState<AdjustBox[] | null>(null)
  const dragRef = useRef<{ key: string; mode: string; sx: number; sy: number; orig: Rect } | null>(null)

  // 接收主进程推送的框数据（全局 DIP → 本窗口局部坐标）
  useEffect(() => {
    window.api.onOverlayInit((data) => {
      const { bounds, boxes: bs } = data
      setBoxes(
        bs
          .filter(
            (b) =>
              b.rect.x < bounds.x + bounds.width &&
              b.rect.x + b.rect.w > bounds.x &&
              b.rect.y < bounds.y + bounds.height &&
              b.rect.y + b.rect.h > bounds.y
          )
          .map((b) => ({ ...b, rect: { x: b.rect.x - bounds.x, y: b.rect.y - bounds.y, w: b.rect.w, h: b.rect.h } }))
      )
    })
  }, [])

  // ESC 取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.api.overlayCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 拖动/调整大小
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      setBoxes((prev) =>
        (prev ?? []).map((b) => {
          if (b.key !== d.key) return b
          if (d.mode === 'move') {
            return { ...b, rect: { x: d.orig.x + dx, y: d.orig.y + dy, w: d.orig.w, h: d.orig.h } }
          }
          let { x, y, w, h } = d.orig
          if (d.mode.includes('e')) w = Math.max(16, d.orig.w + dx)
          if (d.mode.includes('s')) h = Math.max(16, d.orig.h + dy)
          if (d.mode.includes('w')) {
            w = Math.max(16, d.orig.w - dx)
            x = d.orig.x + d.orig.w - w
          }
          if (d.mode.includes('n')) {
            h = Math.max(16, d.orig.h - dy)
            y = d.orig.y + d.orig.h - h
          }
          return { ...b, rect: { x, y, w, h } }
        })
      )
    }
    const up = () => {
      dragRef.current = null
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [])

  const startDrag = (e: React.MouseEvent, box: AdjustBox, mode: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { key: box.key, mode, sx: e.clientX, sy: e.clientY, orig: { ...box.rect } }
  }

  const confirm = () => {
    if (!boxes) return
    const map: Record<string, Rect> = {}
    for (const b of boxes) map[b.key] = b.rect
    window.api.overlayAdjustSubmit(map)
  }

  return (
    <div className="overlay-root" style={{ cursor: 'default' }}>
      <div className="hint-bar">
        定位框已显示在屏幕元素上：拖动框体移动位置，拖动白色圆点调整大小
        <br />
        {(boxes ?? []).some((b) => b.label === '分值输入框') ? (
          <>请核对：绿色「分值输入框」须覆盖整题总分输入框（通常与橙色「提交按钮」相邻），而非小题分数输入框</>
        ) : (
          <>分小题场景：小题分值提交后平台自动累计总分，核对小题分框（青色）与提交按钮（橙色）即可</>
        )}
        <br />
        核对无误后点击下方「确认保存」，按 <span className="kbd">ESC</span> 取消
      </div>
      {(boxes ?? []).map((b) => {
        const color = boxColor(b.key)
        return (
          <div
            key={b.key}
            className="adj-box"
            style={{ left: b.rect.x, top: b.rect.y, width: b.rect.w, height: b.rect.h, borderColor: color, background: `${color}1e` }}
            onMouseDown={(e) => startDrag(e, b, 'move')}
          >
            <span className="adj-label" style={{ background: color }}>
              {b.label}
            </span>
            {b.key !== 'answer' && <span className="adj-center" />}
            {HANDLES.map((dir) => (
              <span key={dir} className={`adj-handle adj-${dir}`} onMouseDown={(e) => startDrag(e, b, dir)} />
            ))}
          </div>
        )
      })}
      <div className="adj-bar">
        <button className="adj-btn ghost" onClick={() => window.api.overlayCancel()}>
          取消
        </button>
        <button className="adj-btn primary" onClick={confirm}>
          确认保存
        </button>
      </div>
    </div>
  )
}
