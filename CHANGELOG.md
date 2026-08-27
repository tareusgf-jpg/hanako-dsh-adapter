# Changelog

本项目按版本记录变更。每条记录根因与方案，便于回溯决策。

## 0.4.0（2026-08-26）— 收尾版

0.4 是本项目的最后一个功能版本（方向小众，做完收尾）。主题：**把欠的债还完**——真机验证、诊断、发行、结果结构化、文档纪律。

### 新增
- **审批闭环真机验证**（`scripts/smoke-approval-real.mjs`，`npm run smoke:approval:real`）：真实 DSH 上全链路验证「沙箱拒绝 → 模型提权 → approval/asked 帧被监听器捕获 → respondApproval 批准 → 任务完成」。真机实证了双通道竞态语义：用户在 DSH Web UI 先批准时，插件尊重决定、不重复应答（already-resolved 视为成功路径）。
- **diagnose 工具**：四件套体检（Node 运行时 / DSH 可执行文件含 --version 冒烟 / 连接状态 / 工作区根目录），每项带人话修复指引，返回 verdict（healthy/degraded/broken）。
- **任务结果摘要**：run-task / get-task 返回新增 `summary` 与 `summaryText`（状态/耗时/工作目录/结果长度/审批账本），交付位置与审批计数一眼可见。task 记录补存 `cwd` 字段（历史记录恢复兼容）。
- **发行管道**：`scripts/pack.mjs` 打包 installable zip（仅运行时文件，结构校验 + 双读者验证）+ `.github/workflows/release.yml`（tag 触发：测试 → 语法检查 → 打包 → GitHub Release 附件）。
- **CHANGELOG.md**：本文档。
- README 新增效果示例章节。

### 修复
- smoke-approval-real 时序缺陷：审批观察与任务提交并行化（此前先等 submit 再观察，审批挂起时 submit 超时先返回）。
- 真机发现：workspace-write 预设下 TEMP 与全局读均在允许边界内，只有「工作区外非临时区写入 → 沙箱拒绝 → 提权」才触发审批——审批验证场景必须用桌面/系统路径。

### 验证
- 194 tests 全绿（+2 diagnose）；`npm run check` 44 文件 0 失败。
- 真机：`smoke:real` OK + `smoke:approval:real` OK（两条路径：插件先应答 / 用户在 Web UI 先批准）。

## 0.3.0（2026-08-16）— Phase 1 审批闭环

### 新增
- **DSH 审批闭环**：`lib/approval-mux-listener.js`（events.mux WS+SSE 双传输、指数退避 500ms→30s、generation 防复活）、`lib/approval-store.js`（原子写、重复帧不复活、rpcId 补令牌）、`lib/approval-service.js`（先持久化后推送、respondApproval 窄方法、reason 脱敏 sk-/Bearer→***、禁止自动批准源码级测试）。
- 路由 `GET/POST /api/approvals`；监听页审批区块 + toast；配置 `dshApprovalNotify` / `dshApprovalTimeoutMs`（默认 0=永久等待，绝不自动批准/拒绝）。
- 安全语义：outcome 仅 `allowed-once`/`rejected`；审批只处理适配器自有会话；reconnect 重拉会话历史（re-pull 补发现）。

### 验证
- 192 tests 全绿；check 40；smoke OK。

## 0.2.0（2026-08-16）— 开源化改造 + 状态机加固

### 变更
- 开源化：`DEFAULT_EXECUTABLE` 从 `$DSH_HOME`/`os.homedir()` 推导、`DEFAULT_ROOTS` 空默认 + 回退 cwd + 警告；manifest 默认值置空；测试换 `os.tmpdir()`；删除内部实现文档（备份至 `_internal/`）；新增 LICENSE(MIT)/.gitignore/CI（Node 20/22）；README 双语化。
- 状态机加固（两轮独立审查 75.6→93.9 分后全部修复）：createSession 透传预分配 sessionId、torn-log 观测宽限（uncertainSince/uncertainReason）、`session-not-found`→orphaned、no-final-output 终态、cancel cancelling 流程 + 状态机回滚边、TaskStore 串行事务式持久化、启动 fail-soft reconcile。
- 新增 `scripts/smoke-real.mjs`（真实 DSH 验证，REAL SMOKE OK）。

## 0.1.0（2026-08-15）— 首个可用版本

### 新增
- 插件骨架：配置（loopback-only URL、固定启动参数、工作区根约束）、进程监督（拉起/回收自有 DSH 进程）、窄 RPC 客户端、任务状态机初版、5 个工具（start/status/run-task/get-task/cancel-task）、只读监听页。
- 安全边界：仅回环地址、窄 RPC 白名单、cwd containment、无通用代理。
