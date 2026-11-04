# Linux Deployment And Operations

## Isolation

This fork runs independently of qq-bridge/DSH. It never edits, stops, upgrades,
or imports the session databases of the old service. An optional first-install
import copies the OneBot endpoints, allow/deny lists and model selection into a
new config. Passing `--credential-file` explicitly copies its DeepSeek API key.
Both configs remain independent. Credentials, login state and runtime data must
not be committed.

The existing OneBot server may be shared in observe mode. The same QQ account
must not be logged into a second protocol server. Concurrent activation of both
agents requires different QQ accounts or disjoint allowlists. The control panel
requires explicit exclusive-use confirmation and does not automatically stop
the old instance.

## Requirements

- Linux with systemd user services, curl, tar, sha256sum, rsync, xz and git
  (the Node.js archive is `.tar.xz`).
- A non-root service user. `install.sh` may be started as root: it creates or
  reuses a dedicated service account (default `qqagent`, or `SUDO_USER`), then
  re-runs the installer as that user. `deploy-all.sh` itself still refuses root.
- Recommended resources: 2 CPU cores, 2GB RAM and 10GB free local disk. A 1GB
  host can OOM while SnowLuma/Chromium starts; SQLite must not live on NFS/SMB.
- Distribution tiers: tested on Ubuntu 22.04/24.04 (current production host).
  Debian 12/13, Ubuntu 26.04, Rocky 9, AlmaLinux 9, Fedora/CentOS Stream/RHEL/Oracle/Amazon Linux,
  Arch/Manjaro, openSUSE/SLES and openEuler/Anolis/Kylin/UOS are attempted through
  their package manager but not tested here. Debian 12 needs Docker's official apt
  repository for Compose v2 (its own repository only ships v1). Alpine/musl, NixOS,
  Gentoo, Void, WSL1 and containers without systemd are unsupported. Run
  `sh scripts/check-platform.sh` for a read-only verdict.
- A separately managed OneBot v11 HTTP/forward WebSocket service when using
  `deploy.sh`; `deploy-all.sh` installs SnowLuma/OneBot.
- An OpenAI Chat Completions compatible model with function calling.
- `loginctl enable-linger USER` for boot without an interactive login.
- A fixed free port; LAN binding requires a console token.

## Full-stack Installation

On a new host (SnowLuma/OneBot not installed yet) the recommended entry is the
zero-question wrapper `install.sh`: it runs the same installer with every
default answered, defers the model configuration to the web console, and ends
with a three-step checklist (tokenized console link, QQ login page, allowlist).

```bash
bash install.sh
# or, on a fresh VPS that only gives you root:
sudo bash install.sh
```

The interactive installer is the same engine with the questions asked instead
of defaulted. `install.sh` may run as root (it switches to a non-root service
account first); `deploy-all.sh` should be run as a regular user and calls
`sudo` only for host dependencies such as Docker and linger.

```bash
bash deploy-all.sh
```

The interactive installer asks for the stack root and all five host ports, plus
the model fields — leaving the model API key blank skips model configuration
(finish it in the console). It does not ask
for a local/LAN IP. New installs bind the Agent console, SnowLuma WebUI and
noVNC to `127.0.0.1` by default; pass `--publish` to bind them to `0.0.0.0`
(and tighten the security group accordingly). Existing installations keep
their current binding unless `--publish`/`--loopback` is passed explicitly.
OneBot HTTP and WebSocket always bind only `127.0.0.1`. If Docker is
missing, the installer asks before installing Docker Engine and Compose through
the host package manager.
The installer does not modify UFW, firewalld or cloud security-group policy.
When host firewall rules are enabled, allow only the three selected user-facing
ports from trusted LAN/VPN ranges. noVNC and OneBot must never be exposed
directly to the public Internet.

The resulting layout is:

```text
STACK_ROOT/
  app/                    deployed QQ Agent code
  data/                   QQ Agent persistent data
  snowluma/
    docker-compose.yml
    .env                   generated service credentials
    data/                  SnowLuma and OneBot configuration
    client-config/         QQ client configuration
    client-data/           QQ login state and cache
  deployment-access.txt   generated URLs and credentials (0600)
```

The SnowLuma image is pinned to the tested `v1.14.22` release by default. Upstream has since
published a v2 line (minimum Node.js 24 and no documented OneBot migration in its release notes);
this project intentionally does not auto-upgrade across that major until it has been tested here.
If you already
deployed an older protocol image, you do not need to edit compose files by hand: the console's
**Settings → OneBot → 协议端（SnowLuma）** panel shows the running version and can update it
(changes `SNOWLUMA_IMAGE` in `.env`, then `compose pull && up -d`; volumes are untouched so the
QQ login survives; a failed update rolls back automatically). The same is available on the CLI:
`node src/ops.js snowluma-version` and `node src/ops.js snowluma-update [--to IMAGE] [--dry-run]`.

Protocol versions below `1.14.20` still work, but stickers sent as "emoji style" render as plain
images in QQ (`sub_type` support landed in SnowLuma `1.14.20`, see issue #468).
Download or container startup failures stop the installation with an error.
One shared OneBot token is written to SnowLuma's global template, every existing
per-account config and QQ Agent's configuration. Existing installations retain
their credentials unless `--rotate-credentials` is selected.

### Container tuning knobs

Two values in `snowluma/.env` are meant to be adjusted per host. Edit them and
recreate the container (`docker compose up -d`; a plain `restart` does not re-read
the environment). Re-running `deploy-all.sh` reads them back, so the edit
survives later deployments:

- `SNOWLUMA_SCREEN` (default `1920x1080x24`) — X screen geometry. Lower it (for
  example `1024x768x24`) when the QQ window renders as a black or blank desktop
  on a host with little video memory.
- `SNOWLUMA_LOG_LEVEL` (default `info`) — container log verbosity.

The rest of `.env` is rewritten on every run. The installer reads its own keys
back, so ports, the image reference and the credentials survive a re-run, but the
wiring keys — container name, internal WebUI/OneBot host and port, uid/gid,
telemetry and hook flags — always come from the installer, and
`docker-compose.yml` is regenerated entirely, including the `SNOWLUMA_QQ_FLAGS`
that disable GPU compositing on headless hosts.

### Docker Hub is unreachable (mainland China)

`registry-1.docker.io` is frequently blocked or DNS-poisoned from mainland
hosts: the pull fails with `dial tcp …: i/o timeout`. The installer retries
through a built-in list of public mirrors automatically (`docker.1panel.live`,
`docker.m.daocloud.io`) and records the one that worked in `snowluma/.env`, so a
fresh install normally needs no extra flags; it stops with a hint only when
those fail too. Any of these three routes works:

```bash
# 1) Add your own mirror (tried before the built-in list; comma-separated)
QQ_AGENT_IMAGE_MIRROR=<mirror-host> bash deploy-all.sh
bash deploy-all.sh --image-mirror <mirror-host>            # same thing
bash deploy-all.sh --image <mirror-host>/motricseven7/snowluma:v1.14.22

# 2) Configure a global accelerator once (Docker then uses it for every pull)
sudo tee /etc/docker/daemon.json <<'JSON'
{ "registry-mirrors": ["https://<accelerator-host>"] }
JSON
sudo systemctl restart docker

# 3) Pull elsewhere and carry the image over
docker pull motricseven7/snowluma:v1.14.22
docker save motricseven7/snowluma:v1.14.22 | gzip > snowluma.tgz
gunzip -c snowluma.tgz | docker load      # on the target host
```

Mirrors are third-party services: the installer automatically tries its
built-in list when Docker Hub is unreachable, and any mirror you pass is tried
first. `SNOWLUMA_IMAGE` / `--image` accept any full reference. The chosen
reference is remembered in `snowluma/.env`, so later runs reuse it — and a
later run strips a remembered mirror prefix before retrying through the
current list, so you can switch mirrors at any time. Cloud-vendor internal
accelerators such as `mirror.ccs.tencentyun.com` only work inside that vendor's
network.

### Existing Environment Protection

Before generating credentials, writing files, downloading dependencies, or
changing services, the installer distinguishes a fresh host from a managed
stack. A `.env` file alone is not proof of ownership. An update requires
matching Agent deployment records, live configuration, Compose configuration
and, when present, container project labels, bind mounts and port mappings.
Changed live credentials or endpoints cause a refusal rather than a reset from
`.env`.

Legacy installations, including an existing Agent that uses an external
`qq-bridge-snowluma` container, are not automatically adopted. Agent data or
deployment records without managed-stack metadata cause an immediate exit.
Partial or failed installations also require operator inspection; automatic
credential regeneration is not performed. Data must not be deleted and metadata
must not be manufactured to bypass these checks. `deploy.sh` updates an existing
Agent while retaining its actual data directory, bind address and OneBot
configuration.

```bash
bash deploy-all.sh --check-only --root-dir /mnt/data/qq-agent
```

`--check-only` is non-interactive and read-only; it does not request model keys
or install missing software. It exits nonzero for unowned, inconsistent or
uninspectable environments. `--yes` and `--rotate-credentials` do not override
ownership checks. Full-stack preflight requires `realpath`, `ss` from iproute2,
and access to the systemd user manager. When Docker is installed, its complete
container inventory, including stopped containers, must be readable; a daemon
or permission error is not treated as an empty host. Interactive deployment can
request sudo; check-only/non-interactive runs require Docker access or
already-authorized non-interactive sudo.

These checks prevent unintended takeover, not failures after deployment has
started. They do not provide a full-stack transaction or data rollback.

On a fresh interactive install, the script also asks for the model endpoint,
API key, model name and QQ allowlists. After the infrastructure checks pass, the
operator opens the printed noVNC URL, scans the QQ login QR code and returns to
the terminal. The installer verifies `get_login_info` and offers to activate the
Agent. QQ login is intentionally the only unavoidable manual protocol step.
Until activation, the Agent stays in `observe`.

Non-interactive `--yes` installation requires `--model-base-url`,
`--model-api-key` and `--model`. Use `--skip-model-config` only when the model
will deliberately be configured later in the management console. An empty
allowlist remains deny-by-default. `--yes` also skips the post-login
verification prompt: the stack stays in `observe` until someone scans the QR code
and activates it later, so an unattended run is not a finished deployment.

`deploy.sh` is used directly when a compatible OneBot service already exists or
when only the QQ Agent process should be installed or updated:

```bash
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 127.0.0.1 --port 3210 \
  --service qq-agent-linux
```

Create the parent directory with appropriate ownership first. Run deployment as
the service user, not root. The installer uses sudo only for linger if required.
When updating, `--install-dir` / `--data-dir` / `--service` / `--repository` /
`--branch` are verified against the installation record (`.deployment.json`)
**before anything is touched** — a mismatch is rejected with exit 2 and nothing
was modified (see 参数校验与逃生开关 below). `--host` and `--port` may be
omitted — the script then reuses the address recorded in `config.json` and
prints a note; when given explicitly they only warn on drift, since the source
of truth for the console address is `config.json`.
Dependencies are installed with `--omit=dev --ignore-scripts`; Linux needs no
Electron, GUI, X11, browser, compiler or native SQLite add-on.
If no compatible Node.js is found, the script downloads Node.js 22 into
`INSTALL_DIR/.runtime` and verifies it against the official SHA-256 manifest.
`--node /absolute/path/to/node` remains available to use an existing runtime.
Run `bash deploy.sh --help` for the complete option list.

For an existing installation, deployment creates a code snapshot under
`DATA_DIR/deploy-backups/` before stopping the service. Source synchronization
uses deletion-aware `rsync` and preserves the data directory, local runtime,
deployment metadata and credentials. If dependency installation, configuration,
systemd validation or health checking fails, the installer restores the previous
code, configuration and service unit before restarting the old service. Use
`--no-backup` only when an external rollback mechanism is already in place.

### 参数校验与逃生开关

`deploy.sh` 在部署开始前调用 `scripts/verify-deployment-target.mjs`，把 `--install-dir` / `--data-dir` /
`--service` / `--repository` / `--branch` 与安装记录（`.deployment.json`）比对：不一致时**打印差异并拒绝**
（exit 2）。拒绝发生在任何改动之前 —— 服务未停、代码未动，因此没有回滚步骤，修正参数重跑即可。

- 数据目录迁移是唯一合法的"不一致"：同时给 `--allow-path-change` 并设环境变量
  `QQ_AGENT_ALLOW_PATH_CHANGE=1`（两个条件缺一不可），旧目录的历史与 Key **不会**自动复制。
- 0.6.x 之前的老安装记录里没有 `repository` / `branch` 字段：会跳过这两项比对并提示，升级部署不受影响。
- `--host` / `--port` 的真相源是 `config.json`：未显式传入时沿用现值；与记录不一致只提示漂移，不拦截。

### 部署被中断后怎么恢复

`deploy.sh` 在停服务之前写 `DATA_DIR/.deploy-in-progress`，健康检查通过后删掉它。
`SIGKILL`、OOM 或掉电会绕过所有 trap，于是可能留下"服务停着、代码只拷了一半"的状态；
少数情况下 systemd 还会从这个半更新的树里把服务拉起来（带着混合代码静默运行）。
判据与恢复步骤：

1. 看标记在不在：`cat "$DATA_DIR/.deploy-in-progress"`。里面有 `pid`、
   `startedAt`、`installDir` 和这次部署前生成的 `snapshot` 路径。
2. 应用启动时会自己检查它：若标记里的 `pid` 已经不存在（说明那次部署真的死了），
   会在服务日志里打出 `[部署] 检测到上次部署被中断`，并在控制台「异常处理」记一条
   `DEPLOY_INTERRUPTED`。pid 还在＝那次部署仍在进行（正常），不会误报。
3. 恢复（用标记里的 `snapshot` 路径；快照是**整个安装目录**）：

   ```
   systemctl --user stop qq-agent-linux
   rsync -a --delete --exclude=/.runtime/ --exclude=/.deployment.json \
     --exclude=/.deployment-node --exclude=/node_modules/ \
     "<snapshot>/app/" "$INSTALL_DIR/"
   systemctl --user start qq-agent-linux
   curl -s http://127.0.0.1:3210/healthz
   rm -f "$DATA_DIR/.deploy-in-progress"
   ```

   快照里不含数据目录（消息库、config.json 都在 `$DATA_DIR`，本次 rsync 不会碰它们），
   所以这一条只回滚代码。若连 systemd unit 也坏了，unit 与部署前的 config 备份在
   `$DATA_DIR/.deploy.lock/state/`（部署被强杀时会留在原地；已被接管清理的话，
   单位文件可由 `deploy.sh` 重新生成）。
4. 确认服务正常后再删标记；不删的话每次启动都会继续告警。

The deployment also installs `${SERVICE}-update.service` and
`${SERVICE}-update.timer`. The timer wakes hourly, while the persisted
`autoUpdate.intervalHours` setting controls whether a GitHub check is due.
Automatic updates default to disabled. When enabled from the Control page, the
updater deploys **published Releases only** (ordinary commits on the branch are
never deployed): it shallow-fetches the release tag into a persistent bare
cache, tests the candidate checkout, then delegates deployment and rollback to
`deploy.sh`. Any failure disables automatic updates (unless
`autoUpdate.disableOnFailure` is explicitly set to false) and queues one
administrator notification. See [GitHub automatic updates](AUTO_UPDATE.md).

The import option is available on the first installation only:

```bash
bash deploy.sh --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data --host 127.0.0.1 --port 3210 \
  --import-bridge /home/<user>/apps/qq-bridge/config.json \
  --credential-file /home/<user>/.config/dsh/credentials.env
```

The first installation enters observe mode and does not activate replies
automatically. Updating an existing installation preserves its current mode.
Model/API settings for non-DeepSeek providers must be configured in the new
console. The repository contains no Electron shell, Windows installer, bundled
protocol launcher, community upload client or telemetry client. The external
OneBot implementation is managed as its own Linux service.

## Control Panel

The console is reachable at `http://HOST:PORT`; the token is obtained with
`bash manage.sh token`. The cookie is HttpOnly and SameSite=Strict, and
credentials are not returned by `/api/config`. On an untrusted network, TLS must
be terminated in front of the service. Plain HTTP on the LAN is not encrypted.
`/healthz` returns liveness plus the deployed version and the OneBot connection
state. API endpoints accept
`x-console-token`. The `?token=` query parameter is accepted **only by `/api/events`** (the SSE
endpoint, which cannot set request headers); every other route takes the token via cookie or the
`x-console-token` header — script callers (e.g. `ops.js`) use the header. Treat any `?token=` URL
as a full credential: use it only for the auto-login shortcut, never paste it elsewhere, and never
over plain HTTP to a host you do not control.

The top selector changes observe/active mode. Observe stores messages but makes
no automatic model calls and blocks text, stickers, pokes and test sends.
Explicit administrator actions such as model testing or memory consolidation
may still use the API. Activation skips the observe backlog by default.

The console Token can be rotated under **Settings → System（系统） → Console Security（控制台安全）**.
Enter the current Token and the new Token twice. A successful rotation updates
the HttpOnly cookie and `data/console-access.txt` atomically from the user's
perspective; the old Token and other browser sessions stop authenticating
immediately. The general “Save Settings” action cannot change the Token.

API keys are never included in `GET /api/config`: any config field whose name matches the
secret pattern (`apikey`, `api_key`, `accesstoken`, `access_token`, `secret`, `password`,
`privatekey`, `private_key`, `authorization`, `x-api-key`, `x_api_key`, or the exact names
`token` / `auth` / `cookie` / `bearer` — the single source of truth is `SECRET_KEY_PATTERN`
in `src/core/secret-keys.js`) is
deleted before the response and replaced with `hasX` flags, so the settings page can show
"configured" without the value. Plaintext keys are echoed **only on demand** by the dedicated
key endpoints (`/api/api-key`, `/api/search-key`, `/api/onebot-key`, `/api/providers/key`,
`/api/asr-key`, `/api/tts/key`, `/api/imagegen/key`), each gated by `keyEndpointAllowed()`: the
request must either carry the console token, or come from a loopback `Host` whose `Origin` /
`Referer` matches this service when one is present — a loopback request with neither is also
allowed, as it is indistinguishable from an address-bar visit. No route returns a key to
an untrusted origin, and no count of endpoints is kept here — a new key field must be added to
that guard.

Run these from the installation directory: `manage.sh` resolves
`.deployment.json` and `.deployment-node` relative to itself, so running it from
the source checkout reports the deployed Node.js runtime as unavailable.

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
# Process old backlog only when deliberately requested:
bash manage.sh activate --confirm-exclusive --with-backlog
bash manage.sh stop
bash manage.sh start
bash manage.sh restart
```

`activate` does not stop qq-bridge. The chats of the old instance must be stopped
or excluded first. Rollback consists of `manage.sh observe` or `stop`; the old
installation is untouched. Multiple processes must not run against one data
directory.

## Message Lifecycle

```text
OneBot -> serialized per-chat ingestion -> deduplicated SQLite message
        -> bounded debounce -> trigger policy -> claim batch lease
        -> fresh system/user prompt -> model/tools -> ack only claimed IDs
                                            -> failure: retry / failed / held
```

- `pending`: awaiting processing, never removed by history retention.
- `leased`: a bounded snapshot belongs to one run, still unacknowledged.
- `acked`: successfully processed or deliberately skipped by trigger policy.
- `failed`: invalid configuration, budget exhaustion, or three failed batch attempts.
- `held`: sending succeeded partially or may have succeeded before failure.
- `deferred`: reply/@/forward enrichment is running in bounded background; not unread
  and not visible to prompts until finalized (or released with a placeholder on timeout).

Held batches are normally reviewed manually. The recovery loop also releases a
held batch automatically once its `outbox.run_id` has no `sending`/`unknown`
rows left — the uncertainty is resolved, so the batch is acknowledged (not
resent). Legacy held rows without a `lease_id` are judged at chat level: they
are released only when that chat has no `sending`/`unknown` outbox rows at all.

On restart, leases remain durable. Recovery runs every five seconds. Expired
leases with no send effects become pending; leases with possible send effects
are held. The default lease lasts four minutes, giving a three-minute run time
limit one minute to unwind. Unexpired leases must not be forcibly stolen.

OneBot has no exactly-once/idempotency contract. A lost HTTP response cannot
prove whether QQ received a message. Outgoing intent is persisted before
sending; unknown delivery stops that batch and holds the chat for operator
review. It is never automatically replayed. Retries therefore do not guarantee
exactly-once sending.

```bash
bash manage.sh retry-failed group:123 --confirm
# AFTER inspecting QQ and the session log; this ACKs, it does not resend:
bash manage.sh resolve-held group:123 --confirm
```

The same actions are available on the archive page. Failure counters are
available there. No forced reply policy is added: at full trigger tier every
batch reaches the model, but the model can finish without sending. Lower tiers
intentionally skip unmatched messages before calling the model.

## Daily Qzone Moments

The optional daily-moments scheduler runs on an `Asia/Shanghai` wall-clock time.
It builds an internal summary from each eligible group's messages, member memory
and handoff state. The model may use a restricted search/fetch tool loop, inspect
recent group images or saved stickers, and then explicitly choose `publish` or
`skip`. Qzone writes use SnowLuma's `send_qzone_msg` action; text and image
publishing requires SnowLuma `1.14.15-node` or newer.

Each run is persisted in `daily-moments.json` before any external write. A
`publishing`, `published` or `publish-unknown` record blocks automatic reruns for
that Shanghai calendar day. Recent Qzone content is also checked before publish
to avoid duplicating an already-created post after an ambiguous response.
On startup, interrupted `running` generation records become `interrupted`;
`publishing` records become `publish-unknown` and remain protected. Manual draft
generation may retry pre-publish failures, but never overrides an uncertain send.
Invalid submission JSON is returned to the model for correction; an exhausted
correction budget is a failure, not an implicit skip.

The console can publish an existing preview by record ID without another model
call, reconcile an uncertain send using the Qzone list, or manually resolve an
uncertain send as confirmed-missed (which unblocks the schedule) or
confirmed-sent. Publishing requires
the current persona fingerprint, source-chat permissions, runtime and active-hours
checks to pass. Details and the persona-oriented prompt design are documented in
[DAILY_MOMENTS.md](DAILY_MOMENTS.md).

## Qzone Interactions

The optional interaction scheduler polls SnowLuma for friend feeds every 60
minutes and checks comment conversations every 5 minutes by default. Both
intervals are configurable. SnowLuma does not currently emit Qzone feed/comment
events, so new activity is detected on the next poll.

Unread feeds are persisted, sorted newest first and submitted to the model as one
batch. The usable input budget is the lower of the configured model context
window and Agent run budget, minus output headroom. Older items omitted by that
budget remain unread for a later cycle.

Likes and top-level comments use SnowLuma `like_qzone` and `comment_qzone`.
Nested replies use the current OneBot Qzone cookie with native
`commentId/commentUin` relation fields. Cookies are never persisted. Every write
is persisted before dispatch; a timeout or restart becomes `unknown` and is not
retried automatically. Details are in
[QZONE_INTERACTIONS.md](QZONE_INTERACTIONS.md).

## Budgets And Context

- `wakeDelayMinMs=8000`, `wakeDelayMaxMs=12000`,
  `drainDelayMs=10000`, `maxBatchWaitMs=20000`.
- Each automatically scheduled batch draws a new debounce delay from the
  configured range. The max-batch timer still caps continuous aggregation at
  20 seconds from the first pending message.
- `store.batchLimit=100`, `store.batchMaxChars=32000`.
- History <=300 messages and <=24000 characters; each message excerpt <=2000 characters.
- Full messages remain on disk and can be inspected via detail/history tools.
- Member memory is limited to related members and <=6000 prompt characters.
- Per-chat handoff state stores confirmed facts, decisions, open questions, the
  next step and last actual reply. It expires after 24 hours by default, is
  capped at 4000 prompt characters, and can be edited or cleared in Memory.
- API request timeout defaults to 60 seconds including the response body.
- Run deadline defaults to 180 seconds, at most 12 rounds and 160000 cumulative tokens.
- Before each additional tool round, the next input is estimated from the preceding
  provider usage with output headroom. A run that would exceed the budget ends safely
  and commits confirmed effects instead of turning them into a held retry.
- Lifecycle generations roll over before the next batch when the preceding request
  reached 32000 input tokens. The character limit remains a secondary fallback.
- Usage of failed attempts is retained; unknown delivery results still require review.
- LLM transient requests retry twice with backoff; persisted batch attempts cap at three.
- Dashboard and usage-page costs are calculated from each provider call's model,
  timestamp, prompt tokens, cached prompt tokens and completion tokens. Calendar-day
  ranges use `Asia/Shanghai` regardless of the Linux host timezone.

Legacy and threaded Agent Sessions use bounded reconstructed context plus the
structured handoff. Lifecycle mode additionally carries the active thread's
provider transcript, including tool traces and provider-returned
`reasoning_content`, into later runs with the same `threadId`. The console exposes
the injected transcript, latest complete model request and per-round provider
Token/cache counters. Total cost still depends on batch size, outputs, images,
tool use and provider caching. Bounded context does not constitute a constant-price
guarantee. General DSH Skills/workspace/approval capabilities are intentionally
not included. Legacy owner friend-approval commands continue to belong to the old
Bridge.

## Active Hours

`timeControl.enabled` defaults to false and bypasses all time rules, including
per-conversation overrides. When enabled, `schedule.mode` is
`deepseek-offpeak`, `custom`, or `always`. The default uses Shanghai weekday
off-peak windows 00:00-09:00, 12:00-14:00, 18:00-24:00 and full weekends.
`overrides["group:<id>"]` and `overrides["private:<id>"]` replace the default;
removing an override restores inheritance. Custom `windows` contain `days`,
`start` and `end`. `days` uses 1=Monday through 7=Sunday; `start` and `end` are
HH:mm, and `end` supports 24:00. An end earlier than start crosses into the
following day. Empty custom windows mean no active hours.

Inactive inputs are recorded as acknowledged history, not queued for catch-up.
Normal conversations retain their legacy/threaded/lifecycle policy during active
hours. Model requests and retries, memory consolidation, token-producing search,
vision/model probes and sends are gated before dispatch. In-flight requests are
aborted at the closing boundary or a configuration change; upstream processing
already accepted by a provider can still incur charges. Unknown deliveries retain
their held state. Daily moments use the global schedule and exclude currently
inactive source conversations, deferring scheduled work while globally inactive.

The master switch is not automatically enabled by deployment. Configure it in
Settings -> Time Control. Status is available at `/api/time-control/status`.

## Data And Backup

The data directory contains `config.json` with mode 0600, `messages.sqlite` plus
WAL/SHM, member memory files, per-chat `memory/*/_handoff.json`,
`daily-moments.json`, `sessions/` and sticker metadata. systemd uses UMask=0077.
Legacy `messages/group_123.json` files migrate once transactionally and are left
unchanged. Corrupt archives abort migration rather than being treated as empty.
Keep messages on a disk with sufficient free space; completed session logs default
to a retention count of 2000 and are additionally pruned after 90 days by the
daily retention sweep (whichever limit hits first).

```bash
# 加密备份（默认 AES-256-GCM；密钥在 ~/.config/qq-agent/backup.key，
# 也可用 QQ_AGENT_BACKUP_KEY 覆盖）。备份目录 0700、文件 0600。
node src/ops.js backup --dry-run
node src/ops.js backup --confirm --keep=4

# 恢复演练：解密最近一份备份到临时目录 + SQLite integrity_check
node src/ops.js backup --drill

# 恢复：先 --dry-run 看条目，再 --confirm；服务起不来会自动回滚
node src/ops.js restore --from ~/qq-agent/backups/qq-agent-data-XXXX.tar.gz.enc --confirm
```

A consistent multi-file snapshot requires observe mode or a cancelled run, and
waiting for runs to finish. SQLite backup uses the online backup API rather than a
raw copy of the database that could omit WAL data. Backups contain credentials
and private messages, so they are encrypted by default; the key file must be
kept separately from the backups (losing it makes the archive unrecoverable).
`--no-encrypt` exists only as an explicit escape hatch.

`restore` stops the service, moves the current data directory to
`data.pre-restore-<timestamp>`, extracts the archive, starts the service and
checks it. If it does not come back, the previous directory is restored
automatically. The old qq-bridge data must not be overwritten.

## Validation

```bash
npm ci --omit=dev --ignore-scripts
npm test
npm run test:unit
node --check src/server.js
bash -n deploy.sh && bash -n deploy-all.sh && bash -n manage.sh
```

Tests use local mock protocol/model servers and isolated temporary data. Real QQ
end-to-end reply validation requires an exclusive test chat/account and explicit
activation. Observe-mode deployment validates receipt without emitting replies.

## OneBot Shows "Not Connected"

The console's Settings → OneBot page spells out the failure reason inline (port
not listening / token mismatch / unresolvable address, with the raw error). The
raw reason is also recorded in `/api/status` under `onebot.error`; one read-only
audit prints it:

```bash
node src/ops.js audit --dir=/mnt/data/qq-agent     # line: "OneBot: connected=false error=…"
journalctl --user -u qq-agent-linux -n 80 | grep -i onebot
```

`ops.js` probes the protocol server on port `3390` by default, while a default
install uses `3000`. Pass `QQ_AGENT_ONEBOT_HTTP_PORT=3000`, or that line reports a
reachable server as unreachable.

The error text identifies the cause:

- `ECONNREFUSED`: nothing listens on that port. Check the protocol container
  with `docker ps -a | grep snowluma`, then
  `docker logs --tail 50 qq-agent-snowluma`.
- `401` / `403`: token mismatch. The `accessToken` in the protocol side's
  `onebot.json` must equal the WebSocket token under Settings → OneBot. The HTTP
  token falls back to the WS token when left empty.
- `ENOTFOUND`: the host does not resolve; the WS URL is wrong, with
  `ws://127.0.0.1:3001` as the default.
- `ETIMEDOUT`: the host is unreachable, by address or firewall.
- `404` / `Unexpected server response`: wrong port; the peer is not a WebSocket
  server. The HTTP port `3000` cannot serve as the WS port.

Three additional failure modes require attention:

- **Address or token changes require a restart.** The connection is created once
  at startup and is not rebuilt when the control panel saves config. Run
  `bash manage.sh restart`.
- The protocol side must expose a **forward WebSocket server**. This service is a
  forward WS client only and does not provide a reverse WS server.
- **Status dot**: green = connected; yellow = connected before and dropped, with
  automatic backoff and reconnection and no restart required; grey = never
  connected.

A logged-out QQ account is not a connection failure: the socket stays up and only
`get_login_info` is missing. Watch it with `node src/ops.js watch-login`.

## 控制台里更新协议端报 docker 权限不足

症状：控制台 →「更新协议端」失败，日志里是

```text
unable to get image: permission denied while trying to connect to the Docker
daemon socket at unix:///var/run/docker.sock
```

而同一个账号在交互 shell 里 `docker pull` / `docker ps` **完全正常**。

**这不是 `docker.sock` 权限配错了，而是跑控制台的那个进程没有 `docker` 组。**

控制台是 systemd **用户服务**，它的补充组（supplementary groups）在 `systemd --user`
管理器启动那一刻就固定了 —— 开了 linger 的机器上就是**开机那一刻**。所以：

1. 你把自己加进 docker 组（`sudo usermod -aG docker $USER`）之后，
2. 新开的交互 shell 拿到了 `docker` 组，命令行一切正常，但
3. 那个一直在跑的 `systemd --user`（以及它下面的控制台/协议端服务）**不会跟着更新**。

于是只有控制台里那条路径会 `permission denied`。查证：

```bash
# 交互 shell 有 docker 组（应当能看到 999 或你的 docker gid）
id
# 控制台进程有没有 —— 输出里没有 docker 的 gid 即中招
systemctl --user show -p MainPID --value qq-agent-linux \
  | xargs -I{} grep ^Groups /proc/{}/status
getent group docker            # 拿到 docker 组的 gid 用于比对
```

修复（会**短暂重启**控制台与协议端）：

```bash
sudo systemctl stop user@$(id -u).service    # 重建用户管理器与它下面的服务
sleep 3                                       # 等旧实例的 cgroup 被回收
sudo systemctl start user@$(id -u).service
# 或直接重启机器
```

重启后再跑一次上面的 `grep ^Groups` 确认 `docker` 的 gid 已经出现。

⚠️ **不要用 `systemctl restart user@` 代替**：2026-10-09 实测（systemd 249）——stop 与 start
挨太近时，新管理器会因旧实例 cgroup 未回收而以 `status=219/CGROUP` 启动失败，且失败后**不会
自动回来**（服务停摆到人工 `start`）；分开两步、留 3 秒间隔，是实测可靠的姿势。

⚠️ **也不要用 `loginctl terminate-user`**：它同样不会把管理器自动带回来（服务会停到你下次登录）。

**重跑一次部署脚本即可检查并修复**：`deploy.sh` / `deploy-all.sh` 在收尾时会检查"部署用户在不在
docker 组、服务进程拿没拿到组"。**自动加组默认关闭**：只有显式设置
`QQ_AGENT_ALLOW_DOCKER_GROUP=1` 才会执行 `usermod -aG docker`；否则只提示、不改权限。
开启后会用 `stop → sleep 3 → start` 重建一次 user manager（服务随 linger 自动恢复；只在交互式部署时做，
自动更新场景跳过重建、只加组）。上面的手工命令留给不便重跑部署的场景。整套检测用的是
`getent` / `usermod` / `systemctl` —— systemd 家族各发行版（Ubuntu / Debian / CentOS /
Fedora / Arch…）通用；非 systemd 的发行版不在支持范围。

### 代价须知：加进 docker 组等于给这个账号 root 等价权限

只有显式开启 `QQ_AGENT_ALLOW_DOCKER_GROUP=1` 后，`deploy.sh` / `deploy-all.sh` 的收尾自愈
才会执行 `usermod -aG docker <部署用户>`。这不是"顺手加的一个组"：docker 组的成员可以起一个
挂载了宿主根目录的容器（`docker run --rm -v /:/host alpine cat /host/etc/shadow`），
**等价于宿主 root**。

所以在**把账号加进 docker 组之前**，控制台被拿下最多是应用级 + 它自己的用户级服务
（控制台跑的命令只有 `systemctl --user`）；加进去之后，同一个进程被拿下就等于宿主机 root。
这是「控制台里更新协议端」这个功能的前提（控制台进程必须能驱动 docker），取舍有三条路：

- **接受它**：显式设置 `QQ_AGENT_ALLOW_DOCKER_GROUP=1` 再部署，省事，功能开箱可用。前提是你信任控制台的访问控制
  （控制台令牌 + `server.host` 的暴露面，见下）。
- **不接受（默认）**：不设置该变量，部署不会自动加组；不要在控制台里更新协议端 —— 把 `autoUpdate.snowluma.enabled` 与
  `followBaseline` 都设为 `false`，改用命令行的 `deploy.sh` / `ops snowluma-update`
  （`sudo` 按需输密码，不需要给常驻进程这个组的权限），并执行
  `sudo usermod -rG docker <部署用户>` 把组摘掉、再重启 user manager（见上）。
- **缩小暴露面**：把 `server.host` 改成 `127.0.0.1` 再通过 SSH 隧道访问控制台。
  `0.0.0.0` + 这个组 + 云安全组放通端口，三样凑齐就是"互联网上有一个能改宿主 root 的面板"。

### 自动回退（仅限未加固的部署）

直接调 `docker` 撞上"套接字没权限"时，更新路径会尝试回退到 `sudo -n docker`（非交互，
一次；没有免密 sudo 就立刻失败，不会挂住）。

⚠️ **但本项目的标准 unit 默认带 `NoNewPrivileges=true` 加固**（`deploy.sh` / `deploy-all.sh`
经 `scripts/install-service.mjs` 生成），内核会禁止这类进程用 `sudo` 提权 —— 加固部署下
这条回退**不会生效**（控制台会直接报"本服务被 NoNewPrivileges 加固，sudo 回退不可用"），
也就是说：**默认配置下没有免密的捷径** —— 修法是上面那条（重启 user manager），或者干脆
重跑一次部署脚本（新版会自动做，见上）。

只有显式关掉加固的部署才会真正走到 `sudo` 回退。本段旧文案曾写"有免密 sudo 就能用、
不必重启 user manager"，那对默认配置是错的，2026-10-09 更正。

不想让服务走提权路径的部署，设 `QQ_AGENT_NO_SUDO_DOCKER=1`（写进
`qq-agent-linux.service` 的 `Environment=`）即可关掉这条回退，那就必须先做上面的人工修复。

为什么不能做得更干净：非 root 进程**无法**给自己补上缺失的补充组 —— 实测
`systemd-run --user -p SupplementaryGroups=docker id` 报
`Changing group credentials failed: Operation not permitted`，而 Ubuntu 上 `sg` 也不是 setgid
的。所以在进程内"自己修好组"这条路是不存在的；未加固的部署上 sudo 回退是唯一能当下就通
的方案，加固部署上则没有免密捷径 —— 这是内核限制，不是配置问题。

### 另外两处让问题更早暴露

- **更新前预检**：`snowluma-update.js` 在动 `.env` 之前先探一次 `docker info`（含回退），
  两条路都不通才给出上面的人工修复步骤，而不是抛一段原始 stderr。
- **巡检新增 `docker-socket` 一项**：每 5 分钟一次的健康检查会 `fs.access` 这个套接字。
  直连不可用且主进程**未**加固时，它会再探一次 `sudo -n docker`（就是上面那条回退），通了就记 ok
  并在详情里说明"更新会走回退" —— 不这么做的话，一条"功能其实能用"的状态会变成每 5 分钟一次、
  连击 3 次就私聊 owner、而且**永远不会恢复**的误报。
  ⚠️ 主进程带 `NoNewPrivileges`（默认配置）时**不再拿巡检进程的 sudo 结果当证据**：那条回退在
  控制台里必失败，巡检会直接报红并指向修法（2026-10-09 审查：此前这里会出一条"假绿"——
  巡检说"会走回退"，用户点按钮照样失败）。
