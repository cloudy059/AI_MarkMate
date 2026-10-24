#!/usr/bin/env node
/**
 * 将 release/linux-unpacked 封装为 .deb 安装包（纯 Node 实现，无需 fpm / Docker / WSL）。
 *
 * 背景：electron-builder 在 Windows 上构建 deb 依赖 fpm（仅有 Linux/macOS 预编译），
 * 因此本脚本在 `electron-builder --linux dir` 产出的 linux-unpacked 目录之上，
 * 自行实现 ustar tar + gzip + ar 归档，产出与官方 deb 结构一致的安装包：
 *
 *   /opt/ai-grading-assistant/**                    应用本体（来自 linux-unpacked）
 *   /usr/bin/ai-grading-assistant                   postinst 中通过 update-alternatives 建立
 *   /usr/share/applications/ai-grading-assistant.desktop
 *   /usr/share/icons/hicolor/{16..256}x{16..256}/apps/ai-grading-assistant.png
 *   /usr/share/doc/ai-grading-assistant/copyright
 *
 * 用法：
 *   node scripts/pack-deb.mjs [--input <linux-unpacked 目录>] [--output <输出目录>] [--arch x64|arm64]
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 参数 ----------
const args = process.argv.slice(2)
function argValue(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const targetArch = argValue('--arch') ?? 'x64'
const inputDir = path.resolve(ROOT, argValue('--input') ?? (targetArch === 'x64' ? 'release/linux-unpacked' : `release/linux-${targetArch}-unpacked`))
const outputDir = path.resolve(ROOT, argValue('--output') ?? 'release')

// ---------- 元数据 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'))
const linuxCfg = cfg.linux ?? {}

const name = pkg.name                                   // ai-grading-assistant（deb 包名 / 图标基名）
const version = pkg.version
const productName = pkg.productName || name
const synopsis = linuxCfg.synopsis || pkg.description || productName
const description = pkg.description || synopsis
const maintainer = linuxCfg.maintainer || `${pkg.author || name} <${name}@localhost>`
const executableName = linuxCfg.executableName || name  // linux-unpacked 中的主程序名
const installDirName = name                             // /opt 下的目录名，用 ASCII 避免兼容性问题
const installPrefix = `/opt/${installDirName}`
const archMap = { x64: 'amd64', arm64: 'arm64', ia32: 'i386' }
const debArch = archMap[targetArch] || 'amd64'

// Electron 运行时依赖（与 electron-builder 26 默认一致）+ nut-js 的 X11 依赖
// xdotool：Linux 上 nut-js 不可用（如 arm64 无预编译）时的自动化降级实现
const depends = [
  'libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils',
  'libatspi2.0-0', 'libuuid1', 'libsecret-1-0',
  // @nut-tree-fork/nut-js (libnut) 需要的 X11 库
  'libx11-6', 'libxkbcommon0', 'libxinerama1',
  // 降级自动化（xdotool，麒麟/UOS/Ubuntu 源内均有）
  'xdotool'
]

if (!fs.existsSync(inputDir)) {
  console.error(`[pack-deb] 找不到输入目录：${inputDir}`)
  console.error(`[pack-deb] 请先运行：npm run build:linux${targetArch === 'arm64' ? ':arm64' : ''}`)
  process.exit(1)
}

// ---------- 工具函数 ----------
const pad512 = (n) => (512 - (n % 512)) % 512
const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0'
const BUILD_TIME = Math.floor(Date.now() / 1000)

/**
 * 流式 tar 写入器（ustar + GNU LongLink 扩展，dpkg 兼容）
 */
class TarWriter {
  constructor(outStream) {
    this.out = outStream
    this.bytesWritten = 0
  }
  async _write(chunk) {
    if (chunk.length === 0) return
    if (!this.out.write(chunk)) await once(this.out, 'drain')
    this.bytesWritten += chunk.length
  }
  async _writeHeader(fields) {
    const h = Buffer.alloc(512)
    const put = (offset, str, len) => { h.write(str, offset, len, 'utf8') }
    put(0, fields.name, 100)
    put(100, octal(fields.mode, 8), 8)
    put(108, octal(fields.uid ?? 0, 8), 8)
    put(116, octal(fields.gid ?? 0, 8), 8)
    put(124, octal(fields.size ?? 0, 12), 12)
    put(136, octal(fields.mtime ?? BUILD_TIME, 12), 12)
    h.fill(' ', 148, 156) // checksum 先置空格
    put(156, fields.typeflag ?? '0', 1)
    put(157, fields.linkname ?? '', 100)
    put(257, 'ustar\0', 6)   // POSIX ustar magic
    put(263, '00', 2)
    put(265, 'root', 32)
    put(297, 'root', 32)
    put(329, octal(0, 8), 8)
    put(337, octal(0, 8), 8)
    let sum = 0
    for (const b of h) sum += b
    put(148, sum.toString(8).padStart(6, '0') + '\0 ', 8)
    await this._write(h)
  }
  /** 路径超过 100 字节时先写 GNU LongLink 条目 */
  async _writeEntryName(archivePath) {
    const buf = Buffer.from(archivePath, 'utf8')
    if (buf.length <= 100) return archivePath.slice(0, 100)
    await this._writeHeader({
      name: '././@LongLink', typeflag: 'L', size: buf.length + 1, mode: 0o644
    })
    const data = Buffer.concat([buf, Buffer.from('\0')])
    await this._write(Buffer.concat([data, Buffer.alloc(pad512(data.length))]))
    return archivePath.slice(0, 100) // 真实 header 里放截断名（会被 LongLink 覆盖）
  }
  async addDir(archivePath) {
    const name = await this._writeEntryName(normalizeEntry(archivePath, true))
    await this._writeHeader({ name, typeflag: '5', mode: 0o755, size: 0 })
  }
  async addBuffer(archivePath, buffer, mode = 0o644) {
    const name = await this._writeEntryName(normalizeEntry(archivePath, false))
    await this._writeHeader({ name, typeflag: '0', mode, size: buffer.length })
    await this._write(Buffer.concat([buffer, Buffer.alloc(pad512(buffer.length))]))
  }
  async addFile(archivePath, realPath, mode = 0o644) {
    const { size } = await fs.promises.stat(realPath)
    const name = await this._writeEntryName(normalizeEntry(archivePath, false))
    await this._writeHeader({ name, typeflag: '0', mode, size })
    const stream = createReadStream(realPath)
    let written = 0
    for await (const chunk of stream) {
      await this._write(chunk)
      written += chunk.length
    }
    if (written !== size) throw new Error(`文件大小不一致：${realPath}`)
    await this._write(Buffer.alloc(pad512(size)))
  }
  async addSymlink(archivePath, target) {
    const name = await this._writeEntryName(normalizeEntry(archivePath, false))
    const link = Buffer.from(target, 'utf8')
    await this._writeHeader({ name, typeflag: '2', mode: 0o777, size: 0, linkname: link.toString() })
  }
  async finish() {
    await this._write(Buffer.alloc(1024)) // 两个结束空块
  }
}

/** tar 条目路径统一为 ./xxx 形式 */
function normalizeEntry(p, isDir) {
  let s = p.replace(/\\/g, '/').replace(/^\//, '')
  if (!s.startsWith('./')) s = './' + s
  if (isDir && !s.endsWith('/')) s += '/'
  return s
}

/** GNU ar 归档成员 */
function arMember(name, data) {
  const header = Buffer.alloc(60)
  const label = (name + '/').padEnd(16, ' ')
  header.write(label, 0, 16, 'ascii')
  header.write('0'.padEnd(12, ' '), 16, 12, 'ascii')        // mtime
  header.write('0'.padEnd(6, ' '), 28, 6, 'ascii')           // uid
  header.write('0'.padEnd(6, ' '), 34, 6, 'ascii')           // gid
  header.write('100644'.padEnd(8, ' '), 40, 8, 'ascii')      // mode
  header.write(String(data.length).padStart(10, ' '), 48, 10, 'ascii')
  header.write('`\n', 58, 2, 'ascii')
  const padding = data.length % 2 === 1 ? Buffer.from('\n') : Buffer.alloc(0)
  return Buffer.concat([header, data, padding])
}

/** 从 resources/icon.ico 提取各尺寸 PNG（ICO 内嵌 PNG 条目） */
function extractIconsFromIco(icoPath) {
  const buf = fs.readFileSync(icoPath)
  const count = buf.readUInt16LE(4)
  const icons = []
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    const w = buf[off] || 256
    const size = buf.readUInt32LE(off + 8)
    const dataOff = buf.readUInt32LE(off + 12)
    const data = buf.subarray(dataOff, dataOff + size)
    if (data[0] === 0x89 && data[1] === 0x50) {
      icons.push({ size: w, png: Buffer.from(data) })
    }
  }
  return icons
}

// ---------- 收集 linux-unpacked 文件 ----------
/** 递归收集 { relPath, absPath, type } 并记录需要写入 tar 的目录 */
function collectFiles(dir) {
  const files = []
  const dirs = new Set()
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
    if (rel !== '') dirs.add(rel)
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      const childAbs = path.join(abs, e.name)
      if (e.isDirectory()) {
        walk(childAbs, childRel)
      } else if (e.isFile()) {
        files.push({ rel: childRel, abs: childAbs })
      } else if (e.isSymbolicLink()) {
        files.push({ rel: childRel, abs: childAbs, symlink: true })
      }
    }
  }
  walk(dir, '')
  return { files, dirs: [...dirs] }
}

/** 归档内文件权限：主程序/崩溃处理器可执行，chrome-sandbox 需 setuid */
function fileMode(rel) {
  const base = path.posix.basename(rel)
  if (base === 'chrome-sandbox') return 0o4755
  if (base === executableName || base === 'chrome_crashpad_handler' || base.endsWith('.sh')) return 0o755
  return 0o644
}

// ---------- 生成 control / maintainer scripts / desktop entry ----------
function buildControl(installedSizeKb) {
  const lines = [
    `Package: ${name}`,
    `Version: ${version}`,
    `Section: ${linuxCfg.packageCategory || 'utils'}`,
    `Priority: optional`,
    `Architecture: ${debArch}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${installedSizeKb}`,
    `Depends: ${depends.join(', ')}`,
    `Description: ${singleLine(synopsis)}`,
    ` ${singleLine(description)}` // 长描述行必须以空格开头
  ]
  return Buffer.from(lines.join('\n') + '\n', 'utf8')
}
const singleLine = (s) => s.replace(/\s+/g, ' ').trim()

function buildPostinst() {
  return Buffer.from(`#!/bin/bash
# 由 scripts/pack-deb.mjs 生成（结构对齐 electron-builder 官方模板）

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executableName}' -a -e '/usr/bin/${executableName}' -a "\`readlink '/usr/bin/${executableName}'\`" != '/etc/alternatives/${executableName}' ]; then
        rm -f '/usr/bin/${executableName}'
    fi
    update-alternatives --install '/usr/bin/${executableName}' '${executableName}' '${installPrefix}/${executableName}' 100 || ln -sf '${installPrefix}/${executableName}' '/usr/bin/${executableName}'
else
    ln -sf '${installPrefix}/${executableName}' '/usr/bin/${executableName}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '${installPrefix}/chrome-sandbox' || true
else
    chmod 0755 '${installPrefix}/chrome-sandbox' || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
`, 'utf8')
}

function buildPrerm() {
  return Buffer.from(`#!/bin/bash
# 由 scripts/pack-deb.mjs 生成

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executableName}' '${installPrefix}/${executableName}' || true
else
    rm -f '/usr/bin/${executableName}'
fi
`, 'utf8')
}

function buildDesktopEntry() {
  const categories = linuxCfg.category
    ? (Array.isArray(linuxCfg.category) ? linuxCfg.category.join(';') : linuxCfg.category)
    : 'Utility'
  return Buffer.from(`[Desktop Entry]
Type=Application
Name=${productName}
Comment=${singleLine(description)}
Exec=${installPrefix}/${executableName} %U
Icon=${name}
Terminal=false
Categories=${categories.endsWith(';') ? categories : categories + ';'}
StartupWMClass=${executableName}
`, 'utf8')
}

function buildCopyright() {
  return Buffer.from(`Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: ${name}
Source: ${pkg.homepage || 'none'}

Files: *
Copyright: ${new Date().getFullYear()} ${maintainer}
License: MIT
 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:
 .
 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.
 .
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
`, 'utf8')
}

// ---------- 主流程 ----------
async function main() {
  console.log(`[pack-deb] 输入: ${inputDir}`)
  console.log(`[pack-deb] 包名: ${name} ${version} (${debArch})`)

  const { files, dirs } = collectFiles(inputDir)
  console.log(`[pack-deb] 应用文件: ${files.length} 个，目录: ${dirs.length} 个`)

  const icons = extractIconsFromIco(path.join(ROOT, 'resources', 'icon.ico'))
  if (icons.length === 0) throw new Error('icon.ico 中未找到 PNG 条目')
  console.log(`[pack-deb] 图标尺寸: ${icons.map((i) => i.size).join(', ')}`)

  // ---- data.tar.gz：应用 + desktop + icons + doc ----
  const dataTarGz = path.join(outputDir, '.pack-deb-data.tar.gz')
  await fs.promises.mkdir(outputDir, { recursive: true })
  {
    const gzip = zlib.createGzip({ level: 6 })
    const fileOut = createWriteStream(dataTarGz)
    gzip.pipe(fileOut)
    const tar = new TarWriter(gzip)

    // 1) /opt/<name>/**（目录先写保证顺序，tar 内父目录先于子条目）
    const allDirs = ['', ...dirs].map((d) =>
      d === '' ? `${installPrefix}` : `${installPrefix}/${d}`
    )
    for (const d of allDirs) await tar.addDir(d)
    for (const f of files) {
      const archivePath = `${installPrefix}/${f.rel}`
      if (f.symlink) {
        const target = await fs.promises.readlink(f.abs)
        await tar.addSymlink(archivePath, target)
      } else {
        await tar.addFile(archivePath, f.abs, fileMode(f.rel))
      }
    }
    // 2) .desktop
    await tar.addDir('./usr/share/applications')
    await tar.addBuffer(`usr/share/applications/${name}.desktop`, buildDesktopEntry(), 0o644)
    // 3) icons
    for (const icon of icons) {
      const dir = `usr/share/icons/hicolor/${icon.size}x${icon.size}/apps`
      await tar.addDir(dir)
      await tar.addBuffer(`${dir}/${name}.png`, icon.png, 0o644)
    }
    // 4) copyright
    await tar.addDir('usr/share/doc/' + name)
    await tar.addBuffer(`usr/share/doc/${name}/copyright`, buildCopyright(), 0o644)

    await tar.finish()
    gzip.end()
    await once(fileOut, 'finish')
  }
  const dataStat = await fs.promises.stat(dataTarGz)

  // ---- control.tar.gz ----
  let controlTarGz
  {
    const entries = new Map() // path -> { buffer, mode }
    // 先算 Installed-Size（data.tar 未压缩大小估算：源文件总大小 + 开销）
    const totalBytes = files.reduce((acc, f) => acc + (f.symlink ? 0 : fs.statSync(f.abs).size), 0)
    const installedSizeKb = Math.ceil(totalBytes / 1024)
    entries.set('./control', { buffer: buildControl(installedSizeKb), mode: 0o644 })
    entries.set('./postinst', { buffer: buildPostinst(), mode: 0o755 })
    entries.set('./prerm', { buffer: buildPrerm(), mode: 0o755 })

    const chunks = []
    const sink = { write: (c) => { chunks.push(c); return true }, end: () => {} }
    const tar = new TarWriter(sink)
    for (const [p, e] of entries) {
      await tar.addBuffer(p, e.buffer, e.mode)
    }
    await tar.finish()
    controlTarGz = zlib.gzipSync(Buffer.concat(chunks), { level: 9 })
  }

  // ---- ar 封装 ----
  const debPath = path.join(outputDir, `${name}_${version}_${debArch}.deb`)
  {
    const debianBinary = Buffer.from('2.0\n', 'ascii')
    const out = Buffer.concat([
      Buffer.from('!<arch>\n', 'ascii'),
      arMember('debian-binary', debianBinary),
      arMember('control.tar.gz', controlTarGz),
      arMember('data.tar.gz', await fs.promises.readFile(dataTarGz))
    ])
    await fs.promises.writeFile(debPath, out)
  }

  // 清理临时文件
  await fs.promises.rm(dataTarGz, { force: true })

  const debStat = await fs.promises.stat(debPath)
  console.log('')
  console.log(`[pack-deb] ✔ 已生成 ${debPath}`)
  console.log(`[pack-deb]   大小: ${(debStat.size / 1024 / 1024).toFixed(1)} MB (data.tar.gz ${ (dataStat.size / 1024 / 1024).toFixed(1)} MB)`)
  console.log('')
  console.log('[pack-deb] Linux 上安装：')
  console.log(`  sudo apt install ./${path.basename(debPath)}   # 或 sudo dpkg -i ${path.basename(debPath)}`)
  console.log('[pack-deb] 卸载：')
  console.log(`  sudo apt remove ${name}`)
}

main().catch((err) => {
  console.error('[pack-deb] 打包失败：', err)
  process.exit(1)
})
