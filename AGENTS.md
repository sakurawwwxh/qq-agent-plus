# Repository Instructions

When adding or changing an experimental feature, follow
[`docs/EXPERIMENTAL_FEATURE_STANDARD.md`](docs/EXPERIMENTAL_FEATURE_STANDARD.md).

In particular:

- treat each experimental feature as an independently owned module;
- keep the experiment settings page limited to enable/disable and graduation;
- give any feature with operational UI its own page;
- keep runtime enablement separate from the persistent `graduated` state;
- preserve data while disabled and never auto-retry unknown external writes.

## 本地访问 Web 控制台（给用户/协作者的入口）

控制台监听地址取决于安装方式：`deploy.sh`、`deploy-all.sh`、`install.sh` 新装默认都只监听
服务器本机 `127.0.0.1:3210`；`deploy-all.sh --publish` / `install.sh --publish` 才监听
`0.0.0.0:3210`（需自行用安全组/防火墙限制来源）。存量安装沿用原绑定。
两条等价入口：

- **无需 Node（推荐给终端用户）**：Windows 用 `console-tunnel.bat`，macOS/Linux 用
  `bash console-tunnel.sh`。首次运行输入 `user@host` 并记住，自动通过 SSH 读取服务器上的
  控制台令牌、建隧道并免登录打开浏览器；`test` 子命令只做连通性自检（返回 `TEST_OK` /
  非零退出），`forget` 清除记住的地址。两个脚本都可从部署机
  `/data/qq-agent/app/` 单文件下载，不需要克隆仓库。
- **macOS / Linux / 本机有 Node**：`SSHHOST=user@host node src/ops.js console --open`
  （`console --print` 只打印 ssh 命令）。

两者行为必须保持一致：同样经 `ssh -L` 隧道转发 3210（控制台）/ 5099（SnowLuma WebUI）/
6081（QQ 扫码登录），不要求服务器开放任何公网端口。改其一请同步改另一个。

## 部署与运维（给 AI 协作者）

要部署、更新或排查线上实例时，先读：`docs/LINUX.md`（部署、控制台、数据与备份、连接排查）、
`docs/OPS.md`（`src/ops.js` 的运维入口）、`docs/BAOTA.md`（宝塔 / aaPanel 面板环境）。五条硬约束：

- **不要以 root 部署**：`deploy-all.sh` 直接拒绝 root；`deploy.sh` 允许 root 但会打印警告，只保留给已有的面板/root 部署场景，新部署优先用 `install.sh` 或普通服务用户。
- **不要用 PM2 或面板的 Node 项目启动**：进程由 systemd 用户服务托管，`manage.sh` 依赖
  `systemctl --user`。
- **`manage.sh` 必须在安装目录（含 `.deployment.json` 的那一层）里执行**；在源码 checkout 里跑会
  报 `Deployed Node.js runtime is unavailable` —— 那是目录不对，不要因此重跑 `deploy.sh`。
- **`install-timers` 现在装五个定时器**：backup（每周日 04:10）、backup-drill（每月 1 日 05:10
  验证备份可解密/可恢复）、process-guard（每 10 分钟）、health（每 5 分钟巡检；连续 3 次失败
  私聊 owner，恢复补发）、audit-prune（每月 1 日 04:20 清理审计日志）。
- **更新时 `--install-dir` / `--data-dir` 必须与现有安装一致**：`deploy.sh` 会在部署开始前把全部参数
  与 `.deployment.json` 记录做强校验（`scripts/verify-deployment-target.mjs`），`--data-dir` / `--service` /
  `--repository` / `--branch` 不符直接拒绝（此时什么都没动，无需回滚）；数据目录迁移需同时给
  `--allow-path-change` 并设 `QQ_AGENT_ALLOW_PATH_CHANGE=1`。`--host` / `--port` 可省略（沿用
  `config.json` 里的现值并打印提示），它们的真相源是 `config.json`，与部署记录不一致只会提示漂移。

## 控制台前端（ui/）约定

控制台是**原生 ES module**（无构建工具，见 `docs/adr/0001-no-build-tools.md`；
2026-10-01 从 classic script 转过来，见 `docs/adr/0005-ui-es-modules.md`）。
动 `ui/` 时守四条：

- **跨文件引用一律 `import`**：每个文件顶部显式列出它用到的外部名字，尾部 `export` 出被别的文件
  用到的名字。**不许再有"靠全局共享的名字"** —— `test/ui-module-graph.test.mjs` 会当场判红
  （未解析引用只剩浏览器内建才放行）。新增文件要同时进 `ui/index.html` 的清单（`test/ui-modules.test.mjs` 盯）。
- **接管渲染入口走 `QARegistry`**（`ui/core/registry.js`）：`onTransform` / `onAfter` / `override`；
  原实现用 `QARegistry.base(name)` 取回。**不要**写 `window[name] = wrapped` 或裸赋值
  `refreshStatus = ...` —— 契约用例判红；而且模块绑定只读，那样写连"碰巧生效"都不会有。
- **改跨文件的可变状态要挂 `state`**（`ui/core/state.js`）：`state.x = …`。模块级 `let` + `export`
  是禁止的（import 绑定只读，别人一写就 `TypeError`），契约用例有两条专门盯这件事。
  另外 `state.x = …` 写在**模块顶层**就等于"求值期读 state"，环上会踩 TDZ 白屏 —— 要初始化就写进 `state.js`，
  要延后的就放进 `init()`（它挂在 `DOMContentLoaded` 之后）。
- **改了 `ui/` 就跑一遍 `docs/UI-SMOKE.md`**：自动化只覆盖"渲染不抛 + 钩子接上了"，
  布局与事件只有人能看。
- **安全网**：`node test/render-test.mjs`/ `node test/scroll-test.mjs`（19）/
  `node test/usage-e2e.mjs`/
  `node --test test/ui-smoke.test.mjs test/ui-module-graph.test.mjs test/ui-real-modules.test.mjs test/ui-registry.test.mjs test/ui-modules.test.mjs`。
  前四个是"剥掉 import/export 按 classic 跑"的 vm 沙箱，`ui-real-modules` 才是真模块语义
  （求值顺序、TDZ 只有它看得见），别把两层的用途混了。

## 发布节奏

- **影响使用的紧急问题**（部署失败、消息发不出/收不到、数据或安全问题）：修完测完即发补丁版。
- **不影响使用的**（文案、观感、边角误报、体验优化、内部加固）：先合入 `main`、同步到服务器自测，
  然后**攒着** —— 攒够一批或与下个功能版一起发。一天最多一版为宜。
- **默认只部署到自有服务器**：改完推 `main`、同步到线上跑着看，不推 tag、不发 Release；
  攒够了再一起发。别为了单个修复开一期版本。
- **版本号接着当前 minor 的补丁位走**（2026-09-28 定）：即使这一批装了新功能，也发
  当前 `0.9.x` 的下一位，不跳 minor（例如不做 0.10.0）——一批功能+修复 = 补丁位 +1。
- 发版流程见 [`docs/AUTO_UPDATE.md`](docs/AUTO_UPDATE.md)：推 `v*` tag → 工作流先跑与 CI 相同的检查、
  再建**草稿** Release → 填说明后发布。不要另用 `gh release create`：同一个 tag 会多出重复草稿。

