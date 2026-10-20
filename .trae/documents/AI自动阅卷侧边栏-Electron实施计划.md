# AI自动阅卷桌面侧边栏 · Electron 实施计划

## 一、背景与目标

在 `f:\AI自动阅卷`（当前为空）从零构建一款 Electron 桌面应用：悬浮侧边栏形式的 AI 自动阅卷助手，配合老师在浏览器中已打开的「现有网页版阅卷系统」工作。核心闭环：

> 用户框选标记（答题区域 / 分值输入框 / 提交按钮坐标）→ 循环：截取答题区域 → AI 识别评分 → 解析得分 → 模拟点击输入框并粘贴分数 → 点击提交 → 等待翻页 → 下一题。

已确认决策：React 18 + TypeScript + Ant Design；交付源码 + electron-builder 打包配置（exe/dmg）；局域网分布式采用「LAN 推理端点」（局域网其他主机上已部署的 Ollama/LM Studio/OpenAI 兼容服务，多节点健康检查+轮询分发）。

## 二、技术栈与版本（已经 npm registry / 官网核实，2026-10）

| 项 | 版本 | 说明 |
|---|---|---|
| Node.js | 22 LTS (≥22.12) | 开发机未装 Node，下载 zip 解压加 PATH（npmmirror.com/mirrors/node/） |
| Electron | 44.7.2 | 最新 stable（Chromium 152） |
| electron-vite | ^5.0.0 | peer 仅支持 vite ^5/^6/^7，**不可装 vite 8** |
| vite / @vitejs/plugin-react | ^7.1.0 / ^5.2.0 | |
| React / antd / icons | 18.3.1 / ^6.6.6 / ^6.3.4 | antd v6 已稳定，v5 停止主维护 |
| zustand | ^5.0.15 | 渲染进程状态 |
| react-markdown / remark-math / rehype-katex / katex | ^10.1.0 / ^6.0.0 / ^7.0.1 / ^0.16.22 | katex 顶层锁定 0.16 与 rehype-katex 内嵌版本一致 |
| @nut-tree-fork/nut-js | 4.2.6（精确锁定） | 唯一 native 依赖，N-API 预编译 win/darwin x64+arm64，asarUnpack |
| electron-builder | ^26.15.3 | NSIS + dmg |
| TypeScript | ~5.9.0 | |

`.npmrc`：`registry=https://registry.npmmirror.com`、`electron_mirror=https://npmmirror.com/mirrors/electron/`、`electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/`（已实测可用）。

依赖划分：仅 `@nut-tree-fork/nut-js` 放 dependencies（electron-builder 只随 dependencies 打包 node_modules），其余全部 devDependencies（renderer 由 vite 打包、main/preload 由 electron-vite 打包）。

## 三、总体架构

三个窗口 + 主进程服务层：

- **侧边栏窗口**（无边框/透明/置顶/可拖拽/贴边，skipTaskbar）：批改控制面板（开始/暂停/停止、四模式切换、当前题状态、分数展示、倒计时、试改人工确认按钮、双评仲裁弹窗、本次统计）。全局快捷键 + 托盘一键隐藏/呼出。
- **设置窗口**：AI 服务商、批改工作流、评分标准、分小题、区域标记、分值配置、预设方案、日志、新手引导 各页面。
- **全屏透明标记 Overlay**（每显示器一个）：框选答题区域、点击标记分值输入框/提交按钮坐标（十字准星+放大镜）。

**评分来源**（统一 `IAiProvider` 接口）：
- 云端：`openai-adapter` 覆盖通义千问/智谱/豆包/Kimi/DeepSeek/OpenAI/Gemini（OpenAI 兼容端点）/讯飞星火/小米AI/MiniMax/自定义中转，`registry.ts` 提供各厂商 baseUrl/默认模型/深度思考参数映射。
- 本机：`ollama-adapter`（/api/chat + think 参数）、`lmstudio-adapter`（/v1）。
- 局域网：`lan-balancer.ts` 多节点 30s 健康检查 + 轮询分发 + 故障转移。

**深度思考全局映射**（registry.ts）：reasoning_effort（OpenAI系/DeepSeek/LM Studio/中转）、enable_thinking+thinking_budget（Qwen3）、thinking.type（智谱/豆包）、thinkingConfig（Gemini）、think:"low|medium|high"（Ollama）、推理模型切换（讯飞/MiniMax/Kimi）。

**三种识别评分模式**（pipeline.ts）：A 多模态直评（整图→多模态模型一步出分）；B 本机OCR二次评分（本地识图模型提取文字+LaTeX→评分模型）；C 云端OCR二次评分（通义VL-OCR/GLM-OCR→评分模型）。

**批改循环状态机**（state-machine.ts）：
```
idle → ready → capturing → [recognizing(B/C)] → scoring → [scoring#2→arbitrating(双评)]
     → awaiting_submit → submitting → waiting_next → capturing（循环）
```
- awaiting_submit 四模式：normal 倒计时5s可取消 / trial 人工确认 / unattended 延时1s / double 仲裁通过后提交。
- 同题检测：dHash 比对上一题，未翻页连续2次→暂停防重复提交。
- 异常恢复：AI 超时指数退避重试3次→备用节点；分数解析失败（JSON mode→正则双通道）重试2次→人工兜底；翻页超时→暂停。全部经 `grading:event` 推送侧边栏。

**截屏**（screenshot.ts）：`screen.getDisplayMatching` → `desktopCapturer.getSources` 按 display_id 匹配 → 物理像素 crop（DIP×scale 换算，实测 image.getSize() 二次修正）。降级链：PowerShell CopyFromScreen / macOS screencapture -R。

**键鼠自动化**（接口抽象+双实现）：`IAutomation{click, press, type, pasteAndRestore}`。实现A nut-js；实现B 零依赖脚本（Win PowerShell user32 / macOS osascript）。启动探针自检，A 失败自动切 B 并 UI 告警。粘贴流程：点击输入框→Ctrl+A→Ctrl+V→恢复剪贴板；网页拦截时回退逐字符 type。

## 四、项目结构

```
f:\AI自动阅卷\
├─ package.json / .npmrc / electron-builder.yml / electron.vite.config.ts
├─ resources\ (icon.ico / icon.icns / tray.png)
└─ src\
   ├─ shared\types.ts                    全局 TS schema（配置/IPC/事件）
   ├─ main\
   │  ├─ index.ts                        单实例锁、托盘、全局快捷键
   │  ├─ windows\{sidebar,settings,overlay}.ts
   │  ├─ ipc\index.ts                    通道注册中心
   │  ├─ services\
   │  │  ├─ config-store.ts              JSON 防抖原子写(tmp+rename)+版本迁移
   │  │  ├─ logger.ts                    JSONL 按天分文件
   │  │  ├─ screenshot.ts               desktopCapturer+DPI换算+crop
   │  │  └─ automation{,-nut,-shell}.ts  接口+实现A/B+探针降级
   │  ├─ ai\{registry,openai-adapter,ollama-adapter,lmstudio-adapter,lan-balancer,connection-test}.ts
   │  └─ grading\{state-machine,pipeline,prompt-builder,score-parser,double-grading,image-hash}.ts
   ├─ preload\index.ts                   contextBridge 类型化 window.api
   └─ renderer\
      ├─ sidebar\                        侧边栏：控制面板/倒计时/确认/仲裁/统计/快捷切换
      ├─ overlay\                        框选UI
      ├─ settings\pages\{providers,workflow,standards,sub-questions,regions,presets,score,logs,onboarding}.tsx
      ├─ components\Markdown.tsx         markdown+LaTeX 渲染
      └─ stores\                         zustand：config / gradingSession / ui
```

关键 IPC：`config:get/patch`、`providers:test`、`lan:upsert/remove/health`、`regions:mark`、`grading:control`(start/pause/resume/stop/confirm/reject/arbiterApply)、`grading:event`(M→R)、`logs:query/export`、`presets:save/apply/export/import`、`automation:calibrate`、`app:toggleSidebar/openSettings`。

配置 schema 要点（shared/types.ts）：`providers[]`（kind/baseUrl/apiKey/visionModel/ocrModel/timeoutMs/enabled）、`lanNodes[]`（baseUrl/kind/health）、`workflow`（mode A|B|C、roles{grader,ocr,grader2}、gradingMode 4种、doubleThreshold、deepThink{enabled,level 1-3}）、`regions`（DIP 矩形+displayId+标记时 scale）、`subQuestions[]`（独立规则/分值/区域）、`scoreConfig`（总分/范围/步长）、`scoringStandards[定长10]`（评分标准/题目题干/参考答案/作答要求/示例参考，任一非空即可批改，仅发送启用套）、`presets[]`（快照+按题型/学科自动匹配规则）。

日志条目：`{ts, level, sessionId, seq, phase, provider, model, latencyMs, imgHash, ocrText?, rawResponse?, parsedScore, finalScore, state, error?}`。

## 五、实施里程碑

- **M1 骨架**：装 Node22+.npmrc → electron-vite 手搭（react-ts）→ 三窗口+托盘+全局快捷键+侧边栏拖拽/隐藏呼出。验证：dev 与打包均运行。
- **M2 配置中心**：config-store + 服务商配置页（密钥校验/自定义地址/超时/实时连接测试）+ 厂商注册表。验证：配置重启不丢、真实 API 连接测试通过。
- **M3 标记+截屏**：overlay 框选三坐标、DPI 换算截屏、dHash。验证：100%/125%/150%/200% 缩放与单/双屏下截图与所见一致。
- **M4 AI 层+pipeline**：三 adapter + 思考参数映射 + 三模式编排 + 分数解析 + JSONL 日志 + 评分标准页（4+1子页/MD+LaTeX预览/AI生成细则/10套管理）。验证：mock + 真实模型手动单题端到端出分。
- **M5 循环+自动化**：双实现自动化 + 状态机 + 四模式 + 双评仲裁 + 分小题/预设方案/日志页。验证：试改模式连真实阅卷系统跑 10 题。
- **M6 打磨发布**：新手引导、统计、导入导出、NSIS+DMG 打包。验证：无人值守 30 题压测稳定、安装包可装。

## 六、验证方案

1. `npm run dev` 启动，核对三窗口、托盘、快捷键、侧边栏拖拽。
2. 每个服务商页「测试连接」真实调用（用户自备任一 API Key）；Ollama/LM Studio 用 `/api/tags`、`/v1/models` 探活。
3. 区域标记后在记事本/网页表单实测自动化链路（点击→粘贴→提交）。
4. 用真实/模拟阅卷页跑试改模式全流程，检查日志页全链路记录（识别文本、原始响应、解析分、最终分、提交状态）。
5. `npm run build:win` / `build:mac` 产出安装包并验证 asarUnpack 后 nut-js 可用、失败时自动降级 shell 实现并有 UI 提示。

## 七、风险与缓解

| 风险 | 缓解 |
|---|---|
| nut-js fork 维护放缓 | 锁 4.2.6 + 实现B（系统脚本）自动降级 + 探针自检 |
| 多显示器/高 DPI 坐标漂移 | 标记时记录 displayId+scale，M3 缩放矩阵测试，变更后提示重新校准 |
| 云端限流/超时 | 指数退避重试3次→备用 provider/LAN 节点故障转移 |
| 分数解析失败 | JSON mode→正则双通道→人工兜底（paused 状态人工填分） |
| 网页输入框拦截粘贴 | 先 Ctrl+A 清空再粘贴纯数字；回退逐字符 type |
| macOS 屏幕录制/辅助功能权限 | 启动检测+引导页（M1 内置检测逻辑，引导文案 M6 完善） |
| 同一题重复提交 | dHash 同题检测，连续2次未翻页自动暂停 |
