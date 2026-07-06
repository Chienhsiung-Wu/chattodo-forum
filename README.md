# 灵信官方中文社区论坛

基于 **NodeBB** 实现的官方中文社区论坛，落地 [`prd/中文社区论坛PRD-V0.0.1.md`](prd/中文社区论坛PRD-V0.0.1.md) 的全部 P0 功能需求（FR-1 ~ FR-6）。

> PRD 原选型为 Discourse，其每一项功能都是 Discourse 的具名能力。本实现选择 **NodeBB**——JS 生态中与 Discourse 插件模型最接近的论坛，多数能力为内置/原生，少量用两个自研薄插件补齐；App SSO 后端、团队 IM、SMTP 等仓库外依赖全部以本地 **mock** 服务闭环跑通。

---

## 一分钟看结果

全流程纯 Node.js 编排（`npm run ...`），**Windows / macOS / Linux 通用**，不依赖 bash / WSL：

```bash
npm install          # 安装编排依赖（express、playwright）
npm run setup        # 从零克隆 NodeBB、打补丁、建库、装插件、灌种子（幂等）
npm run dev           # 启动 Postgres（未运行则自动 docker compose 拉起）+ mock SSO + mock IM + NodeBB
npm run screenshots   # 生成 8 张 DoD 验收截图到 screenshots/
```

打开 <http://localhost:4567> 即为论坛首页。`npm run dev` 运行期间按 `Ctrl+C` 可一次性停止全部服务。验收截图见 [`screenshots/`](screenshots/)。

**前置要求**：Node.js ≥ 22、Git；PostgreSQL 需可连接——已安装 **Docker Desktop** 时 `npm run setup` / `npm run dev` 会自动用 `docker-compose.yml` 拉起，否则请自行安装/启动 PostgreSQL 并用环境变量 `PGHOST`/`PGPORT`/`DBUSER`/`DBPASS`/`DBNAME` 指向它。

---

## 交付物形态

按需求：**克隆现成开源论坛（NodeBB）在其基础上改**，而非从零自研或 Discourse 部署包。

- `nodebb/`（**不入库**，`npm run setup` 重建）：NodeBB v4.11.3 克隆，含一处核心补丁。
- `plugins/`：两个自研薄插件（真源，符号链接进 NodeBB）。
- `mocks/`：闭环 mock 服务（App SSO 后端、团队 IM 中转）。
- `scripts/`：安装、初始化、种子内容、验收截图。
- `screenshots/`：DoD 证据截图。

```
chattodo-forum/
├── prd/                                  两份 PRD（论坛 + AI-Todo App）
├── docker-compose.yml                    真实机器上起 Postgres + Mailpit 的依赖编排
├── mocks/
│   ├── sso/server.js                     mock App 后端（OAuth2；占位邮箱/群组/会员字段逻辑在此）
│   └── im/server.js                      mock 团队 IM 中转（~50 行 adapt，飞书/钉钉/企微/Slack 同构）
├── plugins/
│   ├── nodebb-plugin-chattodo-sso/       FR-1/FR-2：OAuth2 SSO + m- 前缀群组同步 + 角标优先级
│   └── nodebb-plugin-chattodo-forum/     FR-4/FR-5：功能建议按票排序 + 新话题推 IM + 状态标签门禁
├── scripts/
│   ├── install.mjs                       一键重建（幂等，纯 Node.js，Windows/macOS/Linux 通用）
│   ├── dev-up.mjs                        启动全部服务（Ctrl+C 一键停止）
│   ├── dev-down.mjs                      备用：单独停止 NodeBB（终端异常关闭时使用）
│   ├── lib/                              跨平台小工具（进程调用、等待 Postgres 就绪）
│   ├── patch-nodebb.js                   NodeBB 核心补丁（EMFILE 分批并发）
│   ├── bootstrap.js                      群组/版块/权限/staff/会员/种子内容/品牌/语言
│   ├── seed-data.js                      22 篇中文种子正文
│   └── screenshots.mjs                   Playwright 验收截图
└── screenshots/                          DoD 证据
```

---

## 功能需求覆盖（FR-1 ~ FR-6）

| 需求 | 实现方式 | 验证 |
|---|---|---|
| **FR-1 SSO（双轨邮箱）** | 自研 `chattodo-sso` 插件，OAuth2 委托 mock App 后端；`external_id`↔uid 绑定；纯手机号用户生成确定性占位邮箱 `u{id}@users.bbs.chattodo.local` 且跳过邮箱验证 | 截图 01；纯手机号登录成功、无邮箱验证、复登命中同账号 |
| **FR-2 会员身份框架** | 群组 `m-paid/m-pro/m-max/m-lifetime/h-honor/beta`；**前缀隔离**：SSO 仅增删 `m-` 群组，`h-`/`beta` 论坛侧手动、永不经 SSO 移除；主群组角标优先级 荣誉>永久>旗舰>专业>付费 | 截图 05：`zhangming` 显示「会员」角标；王荣誉 honor+paid 双徽章 |
| **FR-3 版块结构与权限** | 6 版块；公告仅 staff 可发帖；**内测专区** 私有仅 `beta` 可见；玩法分享标签白名单 `prompt/工作流/方法论/案例` | 截图 02/06a/06b：free 用户看不到内测专区，beta 用户可见可进 |
| **FR-4.1 功能建议投票** | NodeBB 原生 upvote + 原生 `most_votes` 排序；插件把该版块默认排序强制为按票 | 截图 03：按 5>3>1 票排序 |
| **FR-4.2 状态标签** | 标签白名单 `已计划/开发中/已上线/暂不考虑`；插件 hook 在入库/编辑时**剥离非 staff 的状态标签** | 截图 03：staff 帖带状态标签；非 staff 打标被剥离（已验证） |
| **FR-4.3 已解决标记** | 使用问答/Bug 版块白名单 `已解决` 标签，OP/staff 打标即标记已解决（best-answer 选择列为 V0.x 增强） | 截图 04：`【已解决】` 标签可见 |
| **FR-4.4 Bug 模板** | NodeBB 原生 `category.topicTemplate`，编辑器自动填充附录 A 模板 | 截图 04：编辑器自动填充完整模板 |
| **FR-4.5 内置投票 Poll** | NodeBB 4.11.3 无原生 Poll —— 记为已知缺口（见下） | — |
| **FR-5 团队协作与通知** | 自研 `chattodo-forum` 插件监听 `action:topic.post`，功能建议/Bug 新话题 POST 到 mock IM 中转，适配为机器人文本消息 | 截图 07：mock IM 收到 `【新Bug 反馈】…` |
| **FR-6 上线前内容与配置** | 22 篇中文种子（公告4/问答9/Bug2/建议3/分享4）；3 个官方账号（产品/开发/运营同学）；zh-CN；品牌标题「灵信社区」 | 截图 02：满内容论坛 |

---

## 架构要点

- **NodeBB 原生进程 + Postgres**：NodeBB 以 node 进程运行（可直接用 `./nodebb` CLI / 日志 / bootstrap）；仅数据库走 Postgres。
- **难逻辑下沉到 mock App 后端**：占位邮箱、`add_groups`/`remove_groups`、`member_*` 字段全部由 `mocks/sso/server.js` 的 `/userinfo` 计算，NodeBB 侧插件只消费——与真实对接契约一致。
- **多数能力是原生/配置**，仅两个薄插件承载自研逻辑，控制升级维护面（贴合 PRD「只用官方维护插件」原则）。

### mock 用户（`GET http://127.0.0.1:5555/_users`）

| 选择键 | 显示名 | 邮箱 | SSO 群组 | 论坛手动身份 | 用途 |
|---|---|---|---|---|---|
| `phone` | 手机用户0921 | 无→占位 | — | — | 纯手机号登录 |
| `paid` | 张明 | 真实 | m-paid | — | 会员角标 |
| `honor` | 王荣誉 | 真实 | m-paid | h-honor | 荣誉+付费双徽章、荣誉墙 |
| `beta` | 内测张三 | 真实 | m-paid | beta | 内测专区权限 |
| `free` | 李自由 | 真实 | — | — | 免费基线 |

---

## 跨平台设计（Windows / macOS / Linux）

编排脚本（`scripts/install.mjs`、`scripts/dev-up.mjs`、`scripts/dev-down.mjs`）全部是纯 Node.js，**不依赖 bash / `pg_ctlcluster` / `ln -sfn` / `nohup` / `pkill`**，克隆仓库后 `npm install && npm run setup && npm run dev` 在 Windows 上可直接跑：

- **PostgreSQL**：优先探测并复用已可连接的实例（原生安装、已起的容器、CI 服务容器均可）；探测不到且本机装有 **Docker Desktop** 时，自动 `docker compose up -d postgres`。
- **插件安装**：`fs.symlinkSync(..., 'junction')` 代替 `ln -sfn`——Windows 上目录 junction 无需管理员权限，POSIX 上等价于普通符号链接。
- **命令调用**：一律用 `process.execPath`（当前 node 可执行文件的绝对路径）+ 参数数组直接 spawn，不经过 shell 拼接字符串，规避 Windows `cmd.exe` 的引号转义问题；仅 `npm` 按平台选 `npm`/`npm.cmd`。
- **NodeBB 生命周期**：用官方 `nodebb start` / `nodebb stop`（其 daemon 化基于 `child_process.spawn({detached:true})+unref()`，是纯 Node API，并非 Unix-only 的 `setsid`/双重 `fork`），比"前台子进程 + 逐级转发信号"更可靠。
- **已知局限**：Windows 上跨进程发送 `SIGTERM` 会被当作强制终止而非优雅信号，`Ctrl+C` 停止服务后如端口 4567 仍被占用，`npm run dev` / `npm run dev:stop` 会打印手动收尾指引（`node nodebb/nodebb stop`）而不是静默假装已停干净。

---

## 沙箱环境适配（与原 PRD/常规部署的差异）

本仓库在受限沙箱内构建，做了如下适配（均记录在脚本中，真实部署可回退）：

1. **Docker Hub 镜像被网络策略拦截** → `scripts/lib/postgres.mjs` 探测到环境已有可连接的**原生 Postgres** 后直接复用、不再尝试拉容器（同一套逻辑在真实机器/Windows+Docker Desktop 上会走 `docker compose up -d postgres`，见「跨平台设计」一节）。
2. **NodeBB minifier 子进程 fork 的 IPC 在沙箱内不稳** → `config.json` 设 `threads:1` 令压缩内联执行。
3. **容器 fd 上限 4096 且不可调高**，语言包构建并发开约 4000 文件触发 EMFILE → `patch-nodebb.js` 将其改为分批并发。
4. **NodeBB 插件市场（nbbpm）不可达** → 插件改用 `npm install` 直装。
5. **SSO 直登无需注册插页** → 关闭 GDPR/邮箱注册插页与发帖节流（`gdpr_enabled/postQueue/initialPostDelay=0`），并在插件登录成功后清除 `req.session.registration`。

---

## 已知缺口 / 后续（诚实标注）

- **Topic Voting 的票额上限与关帖自动退票**：NodeBB 无对应机制，本版用原生 upvote + 按票排序近似，票额/退票记为 V0.0.1 缺口。
- **内置 Poll（FR-4.5）**：NodeBB 4.11.3 无原生 Poll，未接入（可评估 `nodebb-plugin-poll`）。
- **已解决的「选定某回复为答案」**：本版以 `已解决` 标签实现标记，best-answer 选择列为 V0.x 增强。
- **邮件 mock（SMTP）**：因 Docker 拉取被拦，未启 Mailpit；FR-5 的通知集成以 **IM 中转**充分演示，邮件通道以配置/文档交付。
- **运维类验收项**（ICP 备案、2FA、备份可恢复、真实邮件送达）：属真实基础设施，本地无法既成，以脚本/文档形式交付。

---

## 常用地址

| 服务 | 地址 |
|---|---|
| 论坛 | <http://localhost:4567> |
| mock SSO 用户表 | <http://127.0.0.1:5555/_users> |
| mock IM 收件 | <http://127.0.0.1:5566/im/received> |
| 荣誉会员墙 | <http://localhost:4567/groups/h-honor> |
