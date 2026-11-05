# MCP：把外部 MCP Server 的工具接进模型

MCP（Model Context Protocol）是一个标准客户端/服务端协议。本项目的 MCP 客户端用 **stdio** 启动外部 server，把 `tools/list` 里的工具接进模型，调用时走 `tools/call`。

默认关闭。配置在 `config.json`：

```json
{
  "mcp": {
    "enabled": true,
    "servers": [
      {
        "id": "files",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/knowledge"],
        "env": {},
        "timeoutMs": 30000,
        "maxCallsPerMinute": 30,
        "toolMounting": "direct"
      }
    ]
  }
}
```

## 字段

- `id`：唯一标识，会出现在工具名 `mcp_<id>_<tool>` 和提示词里；只保留字母数字/下划线/短横。
- `command` / `args` / `env` / `cwd`：启动方式。**等价于执行本机命令**，只填你信任的 server。
- `timeoutMs`：单次 JSON-RPC 请求超时，默认 30 秒。
- `maxCallsPerMinute`：每个 server 每分钟最多调用次数，默认 30。
- `networkIsolation`（可选，默认 `false`）：Linux 上为 `true` 时用
  `unshare --user --map-root-user --net` 启动，server 连不上任何网络接口；适合本地文件/数据库类
  server。需要联网的 server（搜索、GitHub、浏览器）不要开。本机不支持 userns 时启动会直接失败，
  不会静默退化成可联网。
- `permissionIsolation`（可选，默认 `false`）：用 Node 权限模型启动，只允许读入口脚本所在目录
  （或 `cwd`），禁止写文件、子进程、Worker 与 addons。**只对 `command` 是 `node`（或
  `process.execPath`）的 server 生效**；`npx`/`docker` 这类外壳进程会直接启动失败，不会假装隔离。
  白名单目录与数据目录重叠时也会拒绝启动。开启后 `NODE_OPTIONS`/`LD_PRELOAD` 等能改写启动行为的
  环境变量会被剥掉（业务令牌保留）。
- `memoryMb`（可选，默认 0）：配合 `permissionIsolation` 给 server 设 V8 堆上限（64–4096MB）。
- `toolMounting`：
  - `direct`：每个工具各挂一个定义，模型直接看到工具名；
  - `meta`：只挂一个 `mcp_call`，参数里选 server/tool，适合工具多、想省提示词。
- `enabled`（server 级）：单独停某个 server。

## 安全

MCP server 是第三方代码。本项目默认只做三件事：

1. 配置里显式写了才启动，默认不启用；
2. 每个 server 有超时和每分钟调用上限；
3. 工具调用失败/超限只回给模型，不记进异常面板。

隔离是可选的：`permissionIsolation` 把 Node 类 server 关进权限模型（只读入口目录、禁止写/子进程/
Worker），`networkIsolation` 在 Linux 上关掉网络。两者都不支持时启动会失败（fail-closed），不会
静默降级。`npx`/`docker` 外壳进程和 Windows/macOS 的网络都没有强隔离，这类 server 仍以当前用户
权限运行：不要给它宿主机根目录、配置文件或密钥目录，只选官方/可信 server。

## 控制台与运维

- 控制台「设置 → 平台 → MCP」可以启用/停用、增删 server、填命令/参数/环境变量、选择 direct/meta、查看运行状态并重载。
- 同一页可以搜「常用预设」（filesystem / memory / git / GitHub / Playwright / Brave Search，离线内置），也可以尝试搜官方 MCP Registry；导入后还是要自己确认命令、目录和令牌。
- 官方 Registry 只提供元数据，不托管包、也不等于安全审计；当前客户端只接 stdio，只支持远程 HTTP 的 server 会标成“不支持 stdio”。
- `GET /api/mcp`：查看每个 server 是否就绪、工具列表、错误；
- `POST /api/mcp/reload`：配置改了之后重载（会停掉旧进程再起）；
- server 意外退出或启动失败会按 2s→60s 指数退避自动重启（默认最多 8 次），成功后重新挂载工具；
  主动重载/停用不会触发重启，重试耗尽后状态里会提示到控制台重载；
- 改 `config.json` 里的 `mcp` 段后，调一次 reload 即可，不用重启整个服务。

## 和插件、RAG 的区别

- **MCP**：标准外部工具，接一个 server 就多一批工具；适合文件、数据库、浏览器、GitHub、内部 API。
- **插件**：跑在本项目子进程里的第三方扩展，能看群消息、发消息、定时任务；适合 QQ 特有逻辑。
- **RAG**：从文档里检索答案；MCP 的 filesystem server 只能读文件，不等于 RAG。

MCP 不会让人设更像真人，它扩展的是“能做什么”。


## Resources（只读，2026-10）

把机器人的一部分数据以 MCP 资源暴露给外部客户端（只读）：

- `qq-agent://memory/people` —— 全局人物记忆（印象摘要，伪造段头已弱化）
- `qq-agent://memes` —— 群梗库（词条→含义）
- `qq-agent://reminders` —— 待触发的定时/周期提醒

启动：`node src/mcp/resource-server.js`（stdio JSON-RPC；环境变量 QQ_AGENT_DATA_DIR 与主进程一致）。
外部 MCP 客户端里把这个命令配成 server 即可。范围刻意收窄：**没有**会话记录、配置与凭据，
也没有任何写路径。
