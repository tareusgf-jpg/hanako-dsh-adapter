# hanako-dsh-adapter

## English (Overview)

**hana-dsh-adapter** is a HanaAgent community plugin that exposes a local
[DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH,
`@deepseek-ai/dsh`) instance as a **controlled local coding execution
backend** — an adapter, not a second harness. DSH remains the single source of
truth for sessions and outputs; this plugin only stores adapter task metadata
and presentation caches.

**Security boundary:** loopback-only DSH URLs, a narrow RPC allowlist
(`status / start / submit / inspect / cancel / overview`), fixed executable +
fixed `web --host 127.0.0.1 --port <port>` arguments (no shell, no user input
on the command line), workspace-root containment for every task `cwd`
(sibling-prefix / `..` / symlink escapes blocked), and it only ever kills a DSH
child process it started itself. Anyone who can reach the plugin's page/tools
can submit local code-execution tasks — enable `full-access` only in a
loopback-only environment.

**Quick start:**

```bash
git clone <your-fork-or-upstream>
cd hana-dsh-adapter
npm install
npm test          # offline; no network, no real DSH required
npm run check     # syntax-check every source file
npm run smoke     # offline closed-loop smoke with fakes
```

Then configure the plugin in Hana (or via `dshUrl` / `dshExecutable` /
`dshWorkspaceRoots`): leave `dshExecutable` empty to auto-derive
`<DSH_HOME>/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js` (from
`$DSH_HOME` or your home directory), and leave `dshWorkspaceRoots` empty to
fall back to the host process's current working directory (a warning is
logged; prefer explicit roots). With a real DSH running, verify end-to-end:

```bash
npm run smoke:real   # requires a REAL local DSH (e.g. dsh web --host 127.0.0.1 --port 3080)
```

**Dependencies:** requires DSH `0.1.0-rc.6` (the Web profile), installed via a
DSH profile — DSH is a **peer dependency** of this plugin and is never bundled.
Runtime requires Node.js >= 20.

---

# hana-dsh-adapter（中文）

HanaAgent 社区插件：把本地 DeepSeek Harness（DSH, `@deepseek-ai/dsh`）作为**受控的本地编码执行后端**暴露给 Hana，而不重新实现 DSH，也不把 DSH 的完整 Web 控制面代理给插件 UI。

这是一个**适配器**，不是第二个 harness。DSH 始终是会话与输出的唯一事实源；本插件只保存适配任务元数据、展示缓存与审批记录。

版本：**0.3.0**（Phase 0：可恢复提交链 + 可靠任务状态机 + 故障恢复 + 正确终态判定；Phase 1：DSH 审批闭环）。

## 安全警告（必读）

DSH 0.1.0-rc.6 的 Web API 是本地代码执行控制面，**没有认证层**；Host/Origin 检查只是可达性保护，不是身份验证。本插件因此强制执行以下边界：

1. 只接受回环 DSH 地址：`http://127.0.0.1:<port>`、`http://[::1]:<port>`、`http://localhost:<port>`。LAN、域名、任意 URL 一律拒绝。
2. DSH RPC 只发生在 Node 侧（插件进程内），暴露的 HTTP 面是**窄路由**：`status / start / submit / inspect / cancel / overview / approvals`。没有通用 RPC 代理。
3. 启动 DSH 使用固定可执行文件 + 固定参数 `web --host 127.0.0.1 --port <配置端口>`；**不使用 shell**，不拼接任何用户输入。
4. 任务 `cwd` 必须经过 canonicalize，且位于配置的工作区根目录之下（阻止 sibling-prefix、`..` 穿越、符号链接逃逸）。
5. 插件只终止**自己启动**的 DSH 子进程；外部已运行的 DSH 会被复用，绝不会被杀死。
6. 不暴露凭据、设置修改、命令执行、预设修改或任意 DSH 端点转发。
7. 监听聚合 `overview` 对单任务读取失败 fail-soft：只返回截断、去控制字符的 redacted 错误码/消息，绝不带出工具参数、完整事件或原始 payload。
8. 适配任务记录**不保存 prompt 原文**（只存摘要与长度），`session.prompt` 是一次性写入、无幂等键；故障恢复绝不重发 prompt。
9. **审批闭环安全红线（Phase 1，见下）**：自动批准在结构上不可能发生；`outcome` 白名单只有 `allowed-once` / `rejected`；审批 reason 入库/上屏前一律脱敏；监听页不直连 DSH。
10. **经验教训（给 DSH 插件开发者）**：DSH 插件加载器对 Typert Remote 的 namespace/service **命名冲突会拒绝加载**（例如 `dsh-backup` 的 `backupPanel` 冲突案例）。写 DSH 插件时应避免 service 与 namespace 同名，否则插件可能无法被宿主加载——这是插件生命周期层面的硬性约束，不是运行时错误，排查时要先检查命名。

> 任何能访问本插件管理页面/工具的人，都等于能提交本地代码执行任务，也能批准/拒绝 DSH 提权请求。请只在本机回环环境中启用 `full-access`。

## 功能（Phase 0）

- `status` — 插件版本、DSH 地址与可达性、进程归属（owned/external）、可执行文件是否存在、允许的工作区根。
- `start` — 探测优先；不可达时用固定参数启动本地 DSH；已在运行则复用并报告 `owned: false`；幂等，不重复启动。
- `submit` — **可恢复提交链**（见下）；`waitSeconds` 可选（0=异步，最大 900），同步等待时轮询 `session.list`、从 `session.history` 提取最终 assistant 文本。
- `inspect` — 任务元数据 + DSH 会话状态 + 最终文本；同时是**观测点**：把任务按状态机推向前进；`raw=1` 时才返回事件摘要（只含 seq/type/time、**assistant 文本**与工具名；user/message 文本、prompt 原文、工具参数、凭据与 stack 一律不含）。
- `cancel` — 只调用 `session.cancel` 取消对应 DSH 会话；不终止 DSH 服务。语义为 **accepted → cancelling → 观测终止**（见下）。
- `overview` — 监听聚合：`status` + 最多最近 6 个任务的轻量摘要；单任务 DSH 读取失败时 fail-soft，输出 redacted 错误，不影响 status 和其他任务。
- **启动对账** — 插件加载后后台对非终态任务做一次 fail-soft reconcile（DSH 不可达时跳过并记日志，绝不阻塞加载、绝无未处理 rejection）。
- 插件页面「DSH 监听」（`/studio`）— 只读观察哨：默认每 3 秒轮询插件自身 `/api/overview`，显示可达性 / URL / 进程归属与 PID / 可执行文件 / 任务总数 / 最近 6 条任务 / 最近错误 / 最近刷新时间，支持手动刷新与自动刷新开关。页面只调用插件窄 API，不内嵌 DSH UI，浏览器不直连 DSH URL，不含任务提交表单。

## 功能（Phase 1：DSH 审批闭环）

DSH 的提权工具调用会进入 `approval/requested` 审批流程（DSH Web profile 的 `events.mux` 事件流）。本插件把它接到 Hana 侧，让用户在「DSH 监听」页批准/拒绝：

- **审批监听** — Node 侧连接 `ws://127.0.0.1:<port>/api/events.mux`（仅回环；Node 20 无全局 WebSocket 时自动降级为同一端点的 SSE），只处理 Adapter 自己管理的会话的 `approval/requested` / `approval/resolved` 帧（其余会话忽略并记日志）。
- **断线自动重连** — 指数退避（500ms 起、2 倍递增、上限 30s），重连成功后从 `session.history` 补拉未决审批（DSH v1 无 `since` 游标：重连 = 重拉）：历史中的 `approval/asked`（无对应 `approval/decided`）补录为 pending 并推送；`approval/decided` 把本地 pending 落地并推送反馈。mux 打开时的服务端重放帧与历史补拉幂等合并（同一 approvalId 只通知一次；重放帧会为历史补录记录补上 DSH 应答令牌 rpcId）。
- **审批记录** — `ApprovalStore`（`approvals.json`，原子写）持久化 pending 审批：approvalId / sessionId / taskId / toolName / 脱敏 reasonSummary / rpcId / 状态（pending→resolved，粘性）/ 时间戳 / 来源（mux|replay）。
- **推送** — 新审批：`session:send` 推送脱敏摘要（`[DSH 审批] 任务 <id> 请求提权：<toolName> <reason摘要> —— 请在 DSH 监听页批准或拒绝`），并 best-effort `task:update` 把关联任务置 `blocked`（宿主无此能力则跳过记日志）；审批落地：`session:send` 反馈「已批准一次 / 已拒绝 / 已取消 / 已失效」。推送失败一律 fail-soft（只记日志，不影响审批记录）。
- **应答（窄方法）** — `POST /api/approvals/:approvalId/respond`（body `{outcome}`），服务端校验记录存在且 pending、`outcome ∈ {allowed-once, rejected}` 白名单、rpcId 存在，再发 DSH `POST /api/respond` client-response 信封（回显帧的 rpcId，payload `{sessionId, approvalId, outcome}`），成功后落地记录并推送反馈。
- **页面交互** — 「DSH 监听」页新增「待处理审批」区块：轮询 `GET /api/approvals` 展示 pending（toolName + 脱敏 reason + 时间），每条带「批准一次」「拒绝」按钮；点击调 `POST /api/approvals/:approvalId/respond`；新审批到达时用 toast 弹窗（`toast.show({message, type:"warning"})`，页面内最小等价实现，与 `@hana/plugin-sdk` 同调用形状）。
- **配置** — `dshApprovalNotify`（默认 true，会话推送总开关；关闭后记录与页面照常，只是不再发消息）；`dshApprovalTimeoutMs`（默认 0 = 未决审批永久等待；>0 时超时未应答的审批被本地标记为超时并推送反馈——**绝不自动批准也绝不自动拒绝**，DSH 侧请求保持挂起，可到 DSH Web 界面处理）。

### 审批闭环安全边界

- **自动批准在结构上不可能**：唯一的 DSH 应答入口是 `ApprovalService.respondApproval`，它只被 `routes/api.js` 的窄路由调用（源码级测试锁定：listener/store 无应答概念，service 内唯一的 `rpc.respondApproval` 调用位于 `respondApproval` 方法内部）。监听、重连、超时、历史补拉任何路径都不会自动应答。
- **`outcome` 白名单**：仅 `allowed-once` / `rejected`（DSH 契约）；`never` 或持久提权词一律不存在于代码中（源码级测试断言）。`approval/resolved` 帧里的 `cancelled` / `unavailable` 只用于落地本地记录与反馈。
- **脱敏**：reason 在**入库前**经 `redactReason` 脱敏（sk-/ghp_/Bearer/长串 token 模式替换为 `***`、折叠空白、按码点截断到 160），API 视图不含 rpcId / sessionId / 原始 reason / 凭据。
- **不直连**：监听页所有请求都走插件自有窄 API（`/api/approvals`），浏览器从不接触 DSH URL 或 DSH Web UI。
- **会话所有权**：只记录/推送 Adapter 自己管理的 session 的审批（与 TaskStore 匹配），其他会话的审批帧被忽略。

## 任务状态机（Phase 0 核心）

状态定义集中在 `lib/task-state.js`（唯一事实源），所有状态迁移只经 `DshAdapterService` 走该状态机：

| 状态 | 含义 | 终态 |
| --- | --- | --- |
| `creating` | 本地记录已持久化（含预分配 sessionId），`session.create` 尚未确认 | 否 |
| `submitting` | `session.create` 已确认，`session.prompt` 交付中/未确认 | 否 |
| `running` | prompt 已接受，DSH 会话运行中（或等待取起） | 否 |
| `cancelling` | `session.cancel` 已被接受，终止待观测确认 | 否 |
| `done` | 空闲 + 明确完成轮次 + 可交付 assistant 文本 | 是 |
| `failed` | 明确 turn 错误 / 断裂日志 / 提交链失败 / 无法确认的异常终态 | 是 |
| `cancelled` | turn 被中止，或取消请求在无轮次会话上生效 | 是 |
| `orphaned` | DSH 会话经 `session.history` 确认不存在 | 是 |
| `no-final-output` | 空闲 + 完成轮次但**没有** assistant 文本（不假报完成） | 是 |

规则：

- **终态粘性**：终态只能保持自身，禁止任何回退（`done` 不会变回 `running`，`cancelled` 不会变回 `cancelling`）。旧状态 `running/done/cancelled/failed` 是状态集合的一等成员，旧 `tasks.json` 记录无需迁移。
- **任何非终态 → 终态**允许（由分类器裁决）；非终态之间的迁移只有明确边：`creating→submitting/running/cancelling`、`submitting→running/cancelling`、`running→cancelling`、`cancelling→creating/submitting/running`（后者是**取消回滚边**：仅当 `session.cancel` RPC 失败时由服务回滚到原状态，观测永远不会走这条边）。
- **空闲 ≠ 成功**：成功必须有可交付 assistant 文本。明确 `turn/end` 原因（DSH 实际事件形状）：
  - `completed` → 有文本 `done`，无文本 `no-final-output`；
  - `aborted` → `cancelled`；
  - `error` → `failed`；
  - `max-tokens` / `interrupted` / `blocked` / 未知原因 → `failed`（绝不假报完成）。
  - 无 `turn/end` 但有输出/已开轮次（断裂日志）→ `failed`；完全无轮次 → `failed(no-turn)`（取消请求已接受且无轮次时 → `cancelled(cancel-settled)`）。
- **`session.list` 找不到条目绝不直接判 done**：先读 `session.history`——能读到（冷会话，persistence inspection）→ 会话存在、按历史分类；只有 `session-not-found` 才算确认不存在 → `orphaned`。
- **短暂读取失败（transport/bad-response 等）不产生终态**：任务保持原状态，错误在 `inspect.dsh.error` / `overview` 中 redacted 呈现。
- **观测基分类宽限窗（默认 30s，可注入）**：`no-turn / interrupted / prompt-lost / prompt-ambiguous / session-missing / cancel-settled` 这类"断言缺失"的判定**从首次观测到该判定起计时**（`uncertainSince`/`uncertainReason` 持久化到 tasks.json，重启可恢复），**同类判定连续观测超过宽限**才落终态；重新 running、出现明确 `turn/end` 或判定变化时清除/重设计时。因此一个跑了很久的任务**第一次**被观测到断裂日志也不会被立即误杀。基于明确 `turn/end` 的判定（done/failed/cancelled/no-final-output）立即生效。
- **无 sessionId 的旧记录**（legacy/malformed）无法探测 DSH：reconcile/inspect 直接保守落 `failed(missing-session-id)`（带 lastError 说明），绝不永久 pending，也绝不向 DSH 发查询；**cancel 同样在发任何 RPC 之前**把记录落成同一个 `failed(missing-session-id)` 并显式报错（code `missing-session-id`），**绝不发送 `cancelSession({ sessionId: null })`**。
- **以 `/` 开头的 prompt 被拒绝**（`invalid-prompt`）：DSH 会把单个 text block 首字符为 `/` 的内容当作 slash command；适配器是编码任务桥，不静默执行命令。

## 提交链（可恢复）

```
1. 预生成 sessionId（session-<uuid>），先持久化本地 task 记录（status=creating）
2. session.create({ sessionId, cwd, agentPreset })   ← DSH 对同 sessionId+cwd 幂等；
                                                        瞬时失败内联重试一次（同 id）
3. 确认后记录 → submitting
4. session.prompt(queue, 单 text block)              ← 一次性写入（无幂等键），失败即 failed(prompt-failed)
5. 确认后记录 → running
6. waitSeconds>0 时轮询观测直到终态或超时
```

失败语义与副作用窗口（准确描述，不夸大）：

- 第 1 步本地持久化失败 → **没有任何 DSH 副作用**，抛出的 `DshAdapterError` 携带预分配 taskId，无会话被遗留。
- 第 2 步 `session.create` 失败 → 记录保持可追踪（`creating`/`failed(create-failed)`），错误携带 `taskId`；若 DSH 返回的 sessionId 与预分配 id **不一致**，记录落 `failed(create-id-mismatch)` 并拒绝改写（绝不静默采用别的 id）。
- 第 3 步持久化 `submitting` 失败 → DSH 会话已创建（记录中 sessionId 可追踪，人工可清理）。
- 第 4 步 `session.prompt` 失败 → DSH 会话存在但未收到 prompt，记录落 `failed(prompt-failed)` 并保留 sessionId；适配器**不自动删除** DSH 会话（保守策略，无破坏性操作）。
- 第 5 步持久化 `running` 失败 → prompt **已被 DSH 接受**，会话有任务在执行；记录停留在 `submitting`（可追踪），reconcile 会从 DSH 历史将其对账到终态。错误携带 `taskId`。
- prompt 原文**不落盘**（脱敏边界），重启恢复只处理 create（幂等）与状态对账，绝不重发 prompt。

## 取消语义（Phase 0）

`session.cancel` 返回 `accepted: true` 时停止是**异步**的，因此：

- **先持久化、后发 RPC**：`cancelling`（含 `cancelRequestedAt` 与 `previousStatus`）在 `session.cancel` 之前落盘（带 CAS），因此 RPC 窗口内的并发观测**绝不会**把任务抢先固化成 `failed`，两个并发 cancel 也只会发一次 RPC；
- 取消请求成功 → 任务保持 `cancelling`（非终态），返回 `{ task, accepted: true }`；
- 终止判定来自**下一次观测**（inspect / overview / 启动对账）：turn 中止 → `cancelled`；turn 实际完成 → `done`；会话确认消失 → `orphaned`；取消后持续空闲且无轮次 → 观测宽限后 `cancelled(cancel-settled)`；
- 取消请求失败 → 经**取消回滚边**回滚到原非终态，记录 `lastError` 并抛出（携带 `taskId`），**绝不误报 cancelled**；
- 终态任务上的 cancel 是无害 no-op（`accepted: false`），正在 cancelling 的任务重复 cancel 也不会重复发 RPC；
- 无 sessionId 的 legacy/malformed 任务无法被取消：cancel 在任何 RPC 之前把记录落成 `failed(missing-session-id)`（与 inspect/reconcile 同一终态语义）并抛出 `missing-session-id` 错误，**绝不发送 `cancelSession({ sessionId: null })`**。

## 测试

```powershell
npm test              # node --test tests/  （无网络、无真实 DSH）
npm run check         # node --check 所有 .js/.mjs
npm run smoke         # 离线闭环 smoke：run-task -> get-task -> cancel -> observe（fake DSH）
npm run smoke:real    # 真实 DSH smoke：连接正在运行的真实 DSH，完整走适配器源码提交并断言终态
```

CI（`.github/workflows/ci.yml`）在 Node 20 / 22 双版本矩阵上自动跑 `npm test` 与 `npm run check`；`smoke:real` 需要真实本地 DSH，**不纳入 CI**（见工作流文件内注释）。

测试覆盖：loopback URL 拒绝、路径 containment / sibling-prefix / 穿越、RPC 信封与错误映射（含 `session.create` **wire payload 携带预分配 sessionId**）、启动幂等与外部进程复用（fake spawn/probe）、只杀自有子进程、TaskStore 原子持久化与坏 JSON 恢复、**持久化失败回滚且不偷提交（M5）、并发更新串行提交、CAS 冲突**、**旧 tasks.json 记录兼容（含新字段缺省）**、状态机词汇与迁移合法性（含**取消回滚边**）、**预分配 sessionId 先落记录再 create、create 幂等重试、create 返回 id 漂移→failed(create-id-mismatch) 且不改写记录、create/prompt 失败可追踪**、终端分类（idle+文本→done、idle+错误→failed、idle+无文本→no-final-output、session missing→orphaned、冷会话不误判）、**观测基宽限窗（长运行首次 torn 不终态→turn/end 到达→done、判定变化重设计时、重新 running 清除、uncertainSince/uncertainReason 跨 TaskStore reopen 持久、重启 reconcile 沿用首次观测时间不重置宽限→超宽限后按同一 reason 落对应终态）**、**cancel 先持久化后 RPC + 并发 inspect 不抢先 failed + 并发 cancel 单 RPC + RPC 失败回滚 + legacy null sessionId→failed(missing-session-id) 且零 RPC**、短暂 RPC 失败不误终态、取消失败不误报、cancelling→观测终止、启动 fail-soft reconcile、**legacy null sessionId→failed(missing-session-id)**、**submit 各阶段 store 失败携带 taskId**、raw/overview **不含 user 文本/prompt 原文/工具参数/凭据/stack**、**slash prompt 拒绝**、submit 编排、等待轮询、最终文本提取、cancel、overview 轻量聚合与 fail-soft/redacted 错误、**run-task 不强制 autoStart**、页面源码约束（无 iframe / 无 DSH URL 直连 / 无提交表单 / 只打插件 API / 审批区块只含白名单按钮与脱敏字段 / toast 弹窗）。

Phase 1 审批闭环新增覆盖：**events.mux 全信封解析（server-request 包 approval 帧、rpcId 保留）、非审批帧忽略、ws URL 推导、SSE 降级解析**、**断线指数退避重连（上限封顶、成功重置、stop 幂等且不复活）**、**transport 工厂抛错重试、帧处理器抛错不崩流**、**审批帧→持久化→session:send 推送（脱敏消息格式）→task:update blocked 顺序**、**reason 脱敏（sk-/ghp_/Bearer/长串 token）**、**非自有会话忽略**、**重复帧不重复通知、resolved 后重放不复活**、**resolved 帧各 outcome 反馈**、**respondApproval 成功信封（client-response → /api/respond）与 allowed-once/rejected 反馈**、**非法 outcome / 不存在 / 已解决 / taskId 不匹配 / 无 rpcId 各错误映射**、**not-pending 回执→superseded、transport 失败保持 pending**、**dshApprovalNotify=false 只关推送不关记录**、**超时只弃置不自动应答**、**历史补拉（asked 补录 replay 源 + decided 落地 + rpcId 后补 + 会话失败 fail-soft）**、**listPending 脱敏视图（无 rpcId/sessionId）**、**推送 fail-soft（bus 抛错不影响记录）**、**路由错误脱敏（404/400/409/500 均无 stack）**、**自动批准不可能（源码级审查：唯一应答调用点位于窄路由）**。

## 真实 DSH smoke（`npm run smoke:real`）

前提：本机已有**真实 DSH 在运行**（如 `dsh web --host 127.0.0.1 --port 3080`，或已运行的 profile）。

```
npm run smoke:real
DSH_SMOKE_URL=http://127.0.0.1:3080 npm run smoke:real   # 覆盖 URL（可选）
DSH_SMOKE_WAIT_SECONDS=300 npm run smoke:real            # 覆盖等待秒数（可选，默认 180，上限 900）
```

行为与约束（都写死在脚本里，不绕开适配器）：

- **走真实源码**：直接实例化项目当前的 `DshRpcClient / DshAdapterService / TaskStore / WorkspacePolicy / DshProcessSupervisor`，提交链与观测（submit → wait 轮询 → inspect）全部经适配器自身代码，无任何 fake。
- **只连回环**：URL 默认 `http://127.0.0.1:3080`；`DSH_SMOKE_URL` 覆盖值仍由 `lib/config.js` 的 `normalizeDshUrl` 校验，非回环（LAN/域名/非 http/带路径等）一律拒绝并以非零码退出。
- **数据目录只在本工程内**：临时目录 `.smoke-real-*` 创建在项目根目录下，`finally` 只清理它自己创建的目录；不停止 DSH（`autoStart: false`，绝不自启/不杀进程）、不安装/不发布插件、不改动工程文件。
- **任务工作目录 = 当前项目目录**；提交的任务只要求回复一个固定标记（禁止调用工具、禁止修改/创建文件）。等待完成后断言：`task/status=done`、`resultText` 含固定标记、`sessionId` 为预分配（`session-<uuid>`）且被 DSH 回显确认的 id——成功路径本身即证明 `session.create` 的 wire 透传生效（id 漂移会落 `failed(create-id-mismatch)`）；随后 `inspect` 再次确认 `done` 且会话存在于 DSH。
- **会创建一个普通会话**：脚本在 DSH 中创建一个普通 DSH 会话并**保留**它（可在 DSH Web UI `http://127.0.0.1:3080` 查看），不做取消/删除——这是真实 smoke 的预期副作用，不会修改工程文件。
- 成功输出 `REAL SMOKE OK`；任何失败以非零退出码结束。

## 目录结构

```text
hana-dsh-adapter/
  LICENSE              # MIT
  .gitignore
  .github/workflows/ci.yml   # Node 20/22 矩阵：npm test + npm run check（离线）
  manifest.json        # 插件清单：page / configuration（含审批配置）/ full-access
  package.json
  index.js             # 生命周期：构建 runtime，后台触发 reconcile，启动审批监听，register 时释放
  lib/
    config.js          # loopback URL / roots（自动推导默认值）/ 配置回退 / 审批配置
    task-state.js      # ★ 任务状态机：状态集 / 迁移规则 / 终态分类器（唯一事实源）
    dsh-rpc-client.js  # 窄 RPC allowlist + 信封校验 + respondApproval（/api/respond 载体）
    dsh-process-supervisor.js  # 探测 / 幂等启动 / 只杀自有 child
    workspace-policy.js        # 路径 containment
    task-store.js      # ctx.dataDir 原子 JSON 元数据存储（旧记录规范化）
    dsh-adapter-service.js     # submit / status / inspect / cancel / reconcile 编排
    approval-store.js          # ★ approvals.json 原子存储（脱敏记录、pending→resolved 粘性）
    approval-mux-listener.js   # ★ events.mux 监听：WS/SSE、指数退避重连、帧解析
    approval-service.js        # ★ 审批闭环编排：入库→推送、respondApproval 窄方法、历史补拉、超时弃置
  routes/
    api.js             # /api/status /api/overview /api/start /api/tasks(/id)(/cancel) /api/approvals(/respond)
    studio.js          # /studio + assets
  assets/              # 「DSH 监听」观察哨页面（CSS/JS，仅轮询插件窄 API；审批区块 + toast）
  tools/               # status / start / run-task / get-task / cancel-task
  tests/               # node:test，无网络依赖（含 fake events.mux）
  scripts/             # check-syntax / smoke-offline（含审批闭环段）/ smoke-real（真实 DSH smoke）
```

## 已知限制

- Windows 上无法直接 `spawn` 裸 `.js`（EPERM），且禁止 `shell: true`，因此启动实现为「当前 Node 解释器 + 固定 bin.js 路径 + 固定参数」。
- 会话历史按尾页（最多 50 条消息）读取；极长会话的早期内容不会出现在摘要中。
- `session.prompt` 无幂等键且 prompt 原文不落盘：提交链恢复只覆盖 create（幂等）；prompt 交付无法确认且无轮次时按 `prompt-ambiguous`/`prompt-lost` 保守失败，用户重提即可，绝不重发。
- **不执行 DSH slash command**：以 `/` 开头的 prompt 一律 `invalid-prompt` 拒绝（DSH 会把它当命令解释）。
- 取消后任务停留在 `cancelling` 直到下一次观测（inspect/overview/对账）确认终止；没有独立的"等待取消"接口（有意为之，避免扩张公开接口）。
- 不做会话删除/归档、凭据/模型设置编辑、预设修改；不代理除审批应答以外的任何 DSH 写操作。
- 审批闭环（Phase 1）依赖 DSH web profile 的 `events.mux`：Node ≥ 22 用内置 WebSocket，Node 20 自动降级为同一端点的 SSE 流。审批监听器随插件 register() 释放；DSH 不可达时监听器指数退避重连，期间不丢记录（重连后从 `session.history` 补拉）。
- 审批等待**不设默认超时**（指挥官决策）：`dshApprovalTimeoutMs` 默认 0 = 永久等待；设为 >0 只是**本地弃置**（记录 timed-out + 推送反馈），绝不自动批准/拒绝，DSH 侧仍挂起。
- 历史补拉发现的审批**没有 DSH 应答令牌（rpcId）**，因此不可经本插件应答（返回 `not-answerable`，需在 DSH Web 界面处理）；若 mux 重放帧随后到达，会自动补上 rpcId 恢复可应答。
- 页面 toast 是 `@hana/plugin-sdk` `toast.show` 的最小 DOM 等价实现（同调用形状，未引入 SDK 依赖）；消息展示直接采用服务端脱敏文本。
- 不在本阶段实现：会话内自然语言回复触发审批（Phase 1 只支持监听页按钮）；`never`/持久提权；审批的会话级策略配置。
