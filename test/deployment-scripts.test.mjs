import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipOnWindows } from './helpers/platform.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...options
  });
}

test('deploy script verifies and rolls back the update service and timer', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /scripts\/auto-update\.mjs/);
  assert.match(source, /UPDATE_SERVICE="\$\{SERVICE\}-update"/);
  // 行锚（^…$）而不是裸子串：注掉/缩进改坏这行都要红（裸匹配连注释都算命中，2026-10-07 复核）
  assert.match(source, /^\s*systemd-analyze --user verify "\$UPDATE_UNIT_FILE"\s*$/m);
  assert.match(source, /systemctl --user enable "\$UPDATE_SERVICE\.timer"/);
  assert.match(source, /WAS_UPDATE_TIMER_ACTIVE.*systemctl --user start "\$UPDATE_SERVICE\.timer"/s);
  assert.match(source, /cp -p "\$LOCK_DIR\/state\/update\.service" "\$UPDATE_UNIT_FILE"/);
  // 回滚失败时 EXIT trap 会删 .deploy.lock；state/ 里的部署前配置必须先复制到恢复目录。
  assert.match(source, /deploy-recovery-/);
  assert.match(source, /cp -a "\$LOCK_DIR\/state\/\." "\$RECOVERY_STATE_DIR\/"/);
  // 回滚已经失败时不能再启动混合代码；启动后还要确认真的 active（Type=simple start 不等于进程活着）。
  assert.match(source, /ROLLBACK_FAILED" != true[\s\S]*?systemctl --user start "\$SERVICE\.service"/);
  assert.match(source, /is-active --quiet "\$SERVICE\.service" \|\| ROLLBACK_FAILED=true/);
  assert.match(source, /QQ_AGENT_SOURCE_REVISION/);
});

// 2026-10-01 审查：接管陈旧锁的判据曾经整个反了（写成 -z），后果是 SIGKILL 之后
// 无人值守的更新永久卡在"Another deployment is running"，而刚 mkdir 还没写 pid 的
// 并发锁反被抢走。这条断言盯住 `-mmin +5` 的判定方向（find 命中才输出 = 必须 -n）。
test('deploy.sh：失败/回滚路径的防线都在（trap、健康闸门、权限、中断标记）', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');

  // ① 出错/中断必须自动回滚：没有这条，一次半途而废的部署会把服务留在坏状态
  assert.match(source, /^trap rollback_deployment ERR INT TERM HUP$/m,
    '必须装 ERR/INT/TERM/HUP → rollback_deployment 的 trap（SSH 断线也要退回去）');
  assert.match(source, /^rollback_deployment\(\) \{$/m, 'rollback_deployment 本体要存在（trap 指向的函数）');

  // ② 健康检查是"装好了"的唯一判据：失败必须回滚 + 非 0 退出，不能打印成功
  const failAt = source.indexOf('HEALTHY=false');
  const gateAt = source.indexOf('[[ "$HEALTHY" == true ]]');
  assert.ok(failAt > 0, 'HEALTHY 初始必须是 false（写成 true 等于闸门永不触发）');
  assert.ok(gateAt > failAt, '健康闸门要在 HEALTHY=false 之后判（顺序反了等于没闸门）');
  const gateLine = source.slice(gateAt, source.indexOf('\n', gateAt));
  assert.match(gateLine, /rollback_deployment/, '健康检查失败的分支里必须调 rollback_deployment');
  assert.match(gateLine, /exit 1/, '并且以非 0 退出（不能打印成功）');

  // ③ 含密钥的产物权限：config.json / console-access.txt / 回滚快照都不能全局可读
  assert.match(source, /^umask 077$/m, '脚本要 umask 077（配置与回滚快照里是明文密钥）');

  // ④ 中断标记：装到一半被打断（SIGKILL/OOM/掉电，不执行 trap）时，systemd 不能把半更新的树
  //    当正常代码拉起来 —— 标记必须成对出现（部署前写、结束或回滚时清）
  // ⚠️ 必须锚**调用点**，不能锚函数定义 —— bash 里定义天然在调用之前，锚定义会让
  //   "两个调用点都被删掉"照样绿（2026-10-03 复审实测过这个假绿）。用"裸调用的行"正则取位置：
  //   定义行是 `name() {`，调用行没有括号与花括号。
  const markAt = source.search(/^\s*mark_deploy_in_progress\s*$/m);
  const clearAt = source.search(/^\s*clear_deploy_marker\s*$/m);
  assert.ok(markAt >= 0, '部署前要真的调用 mark_deploy_in_progress（不是只定义）');
  assert.ok(clearAt >= 0, '结束/回滚时要真的调用 clear_deploy_marker');
  // 取**标记之后**那次停服：rollback_deployment 里也有一次 stop（在标记之前），与本断言无关
  const stopAfterMark = source.indexOf('systemctl --user stop "$SERVICE.service"', markAt);
  assert.ok(stopAfterMark > markAt, '必须先写标记再停服（停服后崩掉才留得下标记给恢复流程用）');
  assert.match(source, /IN_PROGRESS_MARKER="\$DATA_DIR\/\.deploy-in-progress"/,
    '标记落在数据目录（ops 巡检也看它）');
});


test('deploy.sh：只有"属主已死且锁确实超过 5 分钟"才接管陈旧锁', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(
    source,
    /\[\[ -n "\$\(find "\$1" -maxdepth 0 -mmin \+5/,
    '判据必须是 -n（find 的 -mmin +5 命中时才打印路径）；写成 -z 会把语义反过来'
  );
  assert.match(
    source,
    /! lock_owner_alive && stale_enough "\$LOCK_DIR"/,
    '两个条件都要满足：属主进程不在 **且** 锁确实超过 5 分钟'
  );
  assert.doesNotMatch(source, /-z "\$\(find/, '不许再用 -z 判陈旧');
});

// 2026-10-01 审查：deploy.sh 三处收口 —— 路径嵌套要双向都拒、下载 Node 的临时目录要进 EXIT trap、
// 接管陈旧锁要过一道互斥（否则两个并发部署会互相删锁、双双往下走）。
test('deploy.sh：路径嵌套双向都拒、TMP_DIR 进 EXIT trap、抢锁走互斥', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  // 两个方向的拒绝文案都要在（具体比较见下一条用例：已改成归一化后的 *_CANON）
  assert.match(source, /Installation path must not be nested inside the source repository/);
  assert.match(source, /The source repository must not be nested inside the installation path/);
  // 下载 Node 失败时 set -e 直接退出，临时目录必须由 EXIT trap 清（原来只在成功路径 rm）
  assert.match(source, /^TMP_DIR=""$/m, 'TMP_DIR 要先声明：set -u 下 trap 引用未定义变量会报错');
  assert.match(source, /if \[\[ -n "\$TMP_DIR" \]\]; then rm -rf -- "\$TMP_DIR"; fi/,
    'TMP_DIR 必须挂在 EXIT trap 的清理里');
  assert.match(source, /TAKEOVER_DIR="\$LOCK_DIR\.takeover"/);
  assert.match(source, /if ! mkdir "\$TAKEOVER_DIR" 2>\/dev\/null; then/,
    '抢锁前先抢互斥（mkdir 是原子的），只有赢家去删锁重建');
  assert.match(source, /rm -rf -- "\$TAKEOVER_DIR"/, '互斥要跟着 trap 一起收');
});

test('deploy.sh：数据目录排除按规范化路径计算（防 rsync --delete 删数据）', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.ok(source.includes('DATA_CANON="$(canon_path "$DATA_DIR")"'), '数据目录要先归一化');
  assert.ok(source.includes('if [[ "$DATA_CANON" == "$INSTALL_CANON" ]]; then'), '相同目录必须拒绝');
  assert.ok(source.includes('if [[ "$DATA_CANON" == "$INSTALL_CANON/"* ]]; then'), '嵌套判断要用规范路径');
  assert.ok(source.includes('DATA_REL="${DATA_CANON#"$INSTALL_CANON"/}"'), '相对路径要从规范路径算');
  assert.equal(source.includes('DATA_REL="${DATA_DIR#"$INSTALL_DIR"/}"'), false,
    '不能再按原始字符串截：/./、/x/../、尾斜杠会让排除规则匹配不到真实目录');
  // 符号链接数据目录：原始条目必须用不带尾斜杠的规则（带斜杠只匹配目录，链接会被删）
  assert.ok(source.includes('RAW_REL_ESC="$(rsync_escape "$RAW_REL")"'),
    '原始条目要先转义 rsync 通配符');
  assert.ok(source.includes('--exclude="/$RAW_REL_ESC" --exclude="/$RAW_REL_ESC/**"'),
    '原始条目要按文件/链接口径排除，并保护其中内容');
  assert.equal(source.includes('--exclude="/$RAW_REL/"'), false, '原始条目排除不能带尾斜杠');
  assert.ok(source.includes('while [[ "$DATA_TRIMMED" == */ ]]; do DATA_TRIMMED="${DATA_TRIMMED%/}"; done'),
    '数据路径的尾斜杠要剥掉，否则 --install-dir 带 / 时符号链接保护失效');
  assert.ok(source.includes('DATA_TRIMMED="$(realpath -ms -- "$DATA_TRIMMED")"'),
    '不跟随符号链接的规范化：/./、/x/../、重复斜杠都要收干净，但保留链接名');
  assert.ok(source.includes('for RAW_PART in "${RAW_PARTS[@]}"'),
    '原始路径的祖先要逐层检查符号链接');
  assert.ok(source.includes('[[ -L "$INSTALL_DIR/$RAW_PREFIX" ]]'),
    '符号链接祖先必须整条排除，否则 rsync --delete 会删掉链接本身');
  assert.ok(source.includes('rsync_escape()'),
    '数据目录名里的 * ? [ 要转义，不能当 rsync 通配符');
});

// 2026-10-01 第五轮审查 P1/P2：修锁的时候不能把锁修成新的死锁。
//  · 互斥目录自己也要有陈旧兜底：SIGKILL/OOM/掉电不执行 trap，互斥永久遗留时，
//    之后每次接管都会死在"retry in a moment"上；
//  · trap 必须**先于**抢锁安装：抢锁窗口里 exit 1（比如"别的进程刚建了锁"）也要把互斥收掉；
//  · 清理按"确实持有"来：没抢到锁的一方绝不能删别人的锁；
//  · 拿到互斥后要再判一次：判定与抢互斥之间可能被挂起，期间锁已被赢家刷新；
//  · 嵌套判定前先归一化：`//`、`..`、符号链接这些等价写法不能绕过双向拒绝。
test('deploy.sh：互斥有陈旧兜底、trap 先于抢锁、持有才清、抢到互斥后再判一次、路径先归一化', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /stale_enough "\$TAKEOVER_DIR"/,
    '互斥目录本身要过 5 分钟陈旧宽限，否则一次 SIGKILL 就永久卡住自动更新');
  assert.match(source, /Leftover takeover lock \(older than 5 minutes\)/);
  const trapAt = source.indexOf('trap cleanup_lock EXIT');
  const lockAt = source.indexOf('if ! mkdir "$LOCK_DIR" 2>/dev/null; then');
  assert.ok(trapAt > 0 && lockAt > 0, '两个锚点都要在（脚本结构变了就更新这条用例）');
  assert.ok(trapAt < lockAt, 'trap 必须在抢锁之前安装：抢锁窗口里的 exit 1 也要清掉互斥');
  assert.match(source, /if \[\[ "\$LOCK_OWNED" == true \]\]/, '清锁前要确认确实持有它');
  assert.match(source, /if \[\[ "\$TAKEOVER_OWNED" == true \]\]/, '清互斥同理');
  assert.match(source, /the lock was refreshed while taking over/,
    '拿到互斥后必须再判一次陈旧（否则会删掉并发赢家刚建好的锁）');
  // 顺序断言（2026-10-01 第六轮审查）：只钉"有这句话"不够 —— 把 rm 挪到重判**之前**照样全绿，
  // 而那样正好恢复了"删掉并发赢家新锁"的窗口。钉住 take_over_lock 里的真实次序。
  {
    const fnAt = source.indexOf('take_over_lock() {');
    const fnEnd = source.indexOf('\n}', fnAt);
    assert.ok(fnAt > 0 && fnEnd > fnAt, 'take_over_lock 的结构变了就更新这条用例');
    const body = source.slice(fnAt, fnEnd);
    const recheckAt = body.indexOf('if ! lock_is_stale; then');
    const removeAt = body.indexOf('rm -rf -- "$LOCK_DIR"');
    const recreateAt = body.indexOf('mkdir "$LOCK_DIR"');
    assert.ok(recheckAt > 0 && removeAt > 0 && recreateAt > 0, '三个锚点都要在 take_over_lock 里');
    assert.ok(recheckAt < removeAt, '重判必须排在删锁之前（否则并发赢家刚建好的锁会被删掉）');
    assert.ok(removeAt < recreateAt, '先删旧锁再重建（顺序反了等于把刚建的锁又删掉）');
  }
  assert.match(source, /ROOT_CANON="\$\(canon_path "\$ROOT"\)"/, '嵌套判定前先把路径归一化');
  assert.match(source, /INSTALL_CANON="\$\(canon_path "\$INSTALL_DIR"\)"/);
  // 归一化失败必须 fail-closed（2026-10-01 第六轮审查）：原先是 `|| printf '%s' "$1"` 退回
  // 未归一化的原串，等于守卫静默失效 —— 带 `//`、`..`、符号链接的等价写法又能绕过嵌套判定。
  assert.doesNotMatch(source, /realpath[^\n]*\|\|\s*printf/,
    '不许在 realpath 失败时退回未归一化的原串');
  assert.match(source, /Cannot normalize the source path/, '归一化失败要有明确报错');
  assert.match(source, /Cannot normalize the installation path/);
  assert.match(source, /\|\| \{ printf 'Cannot normalize the source path[^\n]*exit 2; \}/,
    '报错之后要真的停（exit 2），不能继续往下跑');
  assert.match(source, /"\$INSTALL_CANON" == "\$ROOT_CANON\/"\*/);
  assert.match(source, /"\$ROOT_CANON" == "\$INSTALL_CANON\/"\*/);
});

// Issue #5（2026-09-22）：国内服务器拉不到 Docker Hub，脚本只报「after 3 attempts」就退出，
// 用户不知道还能换镜像站。这组断言守住四件事：认用户指定的镜像站、用户的值排在前面、
// 一个都没给时用内置兜底列表（2026-10-12 改：不兜底的话每个国内新部署都要先撞一次失败）、
// 失败时给可操作的指引。
test('deploy-all retries through a user-specified image mirror, then a built-in fallback list', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');

  // 列表先置空，之后按"用户给的 → 内置兜底"两段填充
  assert.match(source, /^IMAGE_MIRRORS=\(\)$/m, '镜像站列表要以空数组初始化');
  assert.match(source, /^IMAGE_MIRROR_ARG=""$/m, '--image-mirror 默认必须为空');
  assert.match(source, /^DEFAULT_IMAGE_MIRRORS=\(docker\.1panel\.live docker\.m\.daocloud\.io\)$/m,
    '内置兜底列表要显式定义：国内直连 Docker Hub 必失败，没兜底每个新部署都会先撞一次（2026-10-12）');
  const userMirrorIdx = source.indexOf('IMAGE_MIRRORS+=("$IMAGE_MIRROR_ARG")');
  const defaultsIdx = source.indexOf('for mirror in "${DEFAULT_IMAGE_MIRRORS[@]}"');
  assert.ok(userMirrorIdx > 0 && defaultsIdx > userMirrorIdx, '内置兜底必须追加在用户指定的值之后（用户的优先）');
  assert.match(source, /\[\[ "\$existing" == "\$mirror" \]\] && \{ duplicate=true; break; \}/,
    '内置站与用户给的重名时不再追加（否则同一条地址要在失败路径上多试一遍）');

  // 两条入口：环境变量（逗号分隔）+ 命令行
  assert.match(source, /QQ_AGENT_IMAGE_MIRROR/);
  assert.match(source, /IFS=',' read -r -a IMAGE_MIRRORS/);
  assert.match(source, /--image-mirror\) require_value "\$@"; IMAGE_MIRROR_ARG="\$2"; shift 2 ;;/);
  assert.match(source, /\[\[ "\$mirror" =~ \^\[A-Za-z0-9\.-\]\+\(:\[0-9\]\+\)\?\$ \]\]/, '镜像站 host 要校验格式');

  // 回退顺序：直连（3 次退避）→ 逐个镜像站 → 仍失败才报错
  assert.match(source, /pull_with_retry\(\)/);
  assert.match(source, /if pull_with_retry "\$IMAGE"; then\n  PULLED=true/);
  // 候选引用从 BASE_IMAGE（剥掉**当前列表里认得**的前缀之后）拼，而不是原样拿 IMAGE ——
  // .env 里存着旧镜像前缀时（默认走内置兜底后的常态），不剥就永远换不到新站；
  // 认不出的自定义 registry 引用不猜，照旧原样重试（2026-10-12 审查）。
  assert.match(source, /BASE_IMAGE="\$IMAGE"/);
  assert.match(source, /BASE_IMAGE="\$\{BASE_IMAGE#"\$known"\/\}"/, '旧镜像前缀要先剥掉再重拼');
  assert.match(source, /candidate="\$\{mirror%\/\}\/\$BASE_IMAGE"/);
  assert.match(source, /\[\[ "\$candidate" == "\$IMAGE" \]\] && continue/, '直连那步试过的引用不再原样重试');
  assert.match(source, /if pull_with_retry "\$candidate"; then/);
  // 换了镜像站要把 .env 里的引用一起改掉（compose 走 --env-file），且保持权限
  // ⚠️ 锚**调用点**不是定义点：`update_env_image()` 这个写法只在 699 行的定义处命中，
  // 749 行的调用是 `update_env_image || true` —— 删掉调用照样绿，.env 会继续引用旧镜像
  //（2026-10-07 复核，同文件 60-66 行早写过同款教训）。
  assert.match(source, /^\s*update_env_image( \|\| true)?\s*$/m, '必须真的调用 update_env_image（不是只定义）');
  assert.match(source, /chmod --reference="\$ENV_FILE"/);

  // 失败时的指引：三条路都写到，并说明内置兜底已经自动试过一轮
  assert.match(source, /image_pull_hint\(\)/);
  for (const needle of ['QQ_AGENT_IMAGE_MIRROR=<mirror>', 'registry-mirrors', 'docker save',
    '镜像站由第三方提供', '内置的公共加速站已经自动试过一轮']) {
    assert.ok(source.includes(needle), `失败提示里应包含：${needle}`);
  }
  assert.match(source, /image_pull_hint\n  die /, '先打指引再退出');
});

// 凭据不经手变量、也不进子进程环境：既能少一份密钥驻留，也是 Mimosa「硬编码凭据」规则盯的地方。
test('deploy-all 现读现用凭据，模型 Key 走 0600 文件而不是子进程环境', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.doesNotMatch(source, /^OLD_[A-Z_]*(PASSWORD|TOKEN)[A-Z_]*=/m, '旧凭据不该留在变量里');
  assert.match(source, /stored_value\(\) \{ env_value "\$ENV_FILE" "\$1"; \}/);
  assert.match(source, /SNOWLUMA_PASSWORD="\$\{SNOWLUMA_PASSWORD:-\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)\}"/);
  assert.match(source, /SNOWLUMA_PASSWORD" != "\$\(stored_value SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD\)"/);

  assert.doesNotMatch(source, /export QQ_AGENT_MODEL_API_KEY=/, '模型 Key 不该导出进子进程环境');
  assert.match(source, /mktemp "\$\{TMPDIR:-\/tmp\}\/qq-agent-model-key\.XXXXXX"/);
  assert.match(source, /chmod 600 "\$MODEL_KEY_FILE"/);
  assert.match(source, /export QQ_AGENT_MODEL_KEY_FILE="\$MODEL_KEY_FILE"/);
  // 2026-10-06 复审：EXIT trap 统一收口到 deploy_all_exit（原先分散的 trap 互相覆盖，
  // 且只在设置了 MODEL_API_KEY 时才挂——会顶掉 fresh 清理钩子），Key 文件删除在钩子里兜底。
  assert.match(source, /deploy_all_exit\(\) \{/);
  assert.match(source, /rm -f "\$MODEL_KEY_FILE"/);
  assert.match(source, /trap deploy_all_exit EXIT/);
});

test('configure-linux creates observe config and preserves runtime mode on update', (t) => {
  const dataDir = tempDir(t, 'qq-deploy-config-');
  const script = path.join(repo, 'scripts/configure-linux.mjs');
  const first = runNode(script, [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43210'
  ]);
  assert.equal(first.status, 0, first.stderr);

  const configFile = path.join(dataDir, 'config.json');
  const initial = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(initial.runtime.mode, 'observe');
  assert.equal(initial.server.host, '127.0.0.1');
  assert.equal(initial.server.port, 43210);
  assert.ok(initial.server.token.length >= 32);
  // 安全意图：不得泄露给 group/other。不能精确断言 0600——btrfs（部分 NAS）
  // 上 writeFileSync/chmod 的 mode 会落成 0700（owner-only 但带 x 位，Issue #11）。
  // Windows 没有 POSIX 权限位：Node 在 win32 上 stat.mode 的结构与 POSIX 不同，
  // 这条只能表达“不泄露给 group/other”的安全意图，放到 POSIX 上断言。
  if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o077, 0);

  initial.runtime.mode = 'active';
  fs.writeFileSync(configFile, JSON.stringify(initial), { mode: 0o600 });
  const second = runNode(script, [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43211'
  ]);
  assert.equal(second.status, 0, second.stderr);

  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.runtime.mode, 'active');
  assert.equal(updated.server.host, '0.0.0.0');
  assert.equal(updated.server.port, 43211);
  assert.equal(updated.server.token, initial.server.token);
});

test('configure-linux accepts full-stack credentials and OneBot endpoints', (t) => {
  const dataDir = tempDir(t, 'qq-full-deploy-config-');
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43212'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_CONSOLE_TOKEN: 'agent-console-token-1234',
      QQ_AGENT_ONEBOT_TOKEN: 'onebot-ws-token-1234',
      QQ_AGENT_ONEBOT_HTTP_TOKEN: 'onebot-http-token-1234',
      QQ_AGENT_ONEBOT_WS_URL: 'ws://127.0.0.1:33001',
      QQ_AGENT_ONEBOT_HTTP_URL: 'http://127.0.0.1:33000',
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL_API_KEY: 'model-secret',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_ALLOW_GROUPS: '123,456',
      QQ_AGENT_ALLOW_PRIVATE: '789'
    }
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.server.token, 'agent-console-token-1234');
  assert.equal(config.onebot.wsUrl, 'ws://127.0.0.1:33001');
  assert.equal(config.onebot.httpUrl, 'http://127.0.0.1:33000');
  assert.equal(config.onebot.accessToken, 'onebot-ws-token-1234');
  assert.equal(config.onebot.httpAccessToken, 'onebot-http-token-1234');
  assert.equal(config.api.baseUrl, 'https://model.example/v1');
  assert.equal(config.api.apiKey, 'model-secret');
  assert.equal(config.api.model, 'model-name');
  assert.deepEqual(config.allow.groups, ['123', '456']);
  assert.deepEqual(config.allow.private, ['789']);
});

test('模型 Key 也可以走 QQ_AGENT_MODEL_KEY_FILE（不留在子进程环境里）', (t) => {
  const dataDir = tempDir(t, 'qq-keyfile-config-');
  const keyFile = path.join(tempDir(t, 'qq-keyfile-'), 'model-key');
  fs.writeFileSync(keyFile, 'key-from-file\n', { mode: 0o600 });
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43213'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_MODEL_API_KEY: '',
      QQ_AGENT_MODEL_KEY_FILE: keyFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.api.apiKey, 'key-from-file', '尾随换行要被去掉');

  // 文件不存在时报错要指得出是哪个变量，而不是静默当成没配 Key
  const missing = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', tempDir(t, 'qq-keyfile-missing-'),
    '--host', '127.0.0.1',
    '--port', '43214'
  ], {
    env: { ...process.env, QQ_AGENT_MODEL_KEY_FILE: path.join(dataDir, 'nope') }
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /QQ_AGENT_MODEL_KEY_FILE/);
});

test('configure-snowluma synchronizes global and per-account server tokens', (t) => {
  const dataDir = tempDir(t, 'qq-snowluma-config-');
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'onebot_12345.json'), JSON.stringify({
    mode: 'snapshot',
    networks: {
      httpServers: [{ name: 'custom-http', host: '127.0.0.1', port: 3100 }],
      wsServers: [{ name: 'custom-ws', host: '127.0.0.1', port: 3101, role: 'Event' }]
    }
  }));

  const result = runNode(path.join(repo, 'scripts/configure-snowluma.mjs'), [
    '--data-dir', dataDir,
    '--token', 'shared-onebot-token-1234',
    '--http-port', '3000',
    '--ws-port', '3001'
  ]);
  assert.equal(result.status, 0, result.stderr);

  for (const name of ['onebot.json', 'onebot_12345.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
    assert.equal(config.networks.httpServers[0].host, '0.0.0.0');
    assert.equal(config.networks.httpServers[0].port, 3000);
    assert.equal(config.networks.httpServers[0].accessToken, 'shared-onebot-token-1234');
    assert.equal(config.networks.wsServers[0].host, '0.0.0.0');
    assert.equal(config.networks.wsServers[0].port, 3001);
    assert.equal(config.networks.wsServers[0].accessToken, 'shared-onebot-token-1234');
  }
  assert.ok(fs.existsSync(path.join(configDir, 'onebot_12345.json.bak')));
});

test('installed manage launcher uses the exact deployed Node runtime', { skip: skipOnWindows('Fake node/launcher are #!/bin/sh scripts; Windows cannot exec them') }, (t) => {
  const root = tempDir(t, 'qq-deploy-root-');
  const home = tempDir(t, 'qq-deploy-home-');
  const data = path.join(root, 'data');
  const capture = path.join(root, 'node-invocation.txt');
  const fakeNode = path.join(root, 'private-node');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(repo, 'manage.sh'), path.join(root, 'manage.sh'));
  fs.writeFileSync(path.join(root, 'scripts/manage.mjs'), '');
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, { mode: 0o700 });

  const install = runNode(path.join(repo, 'scripts/install-service.mjs'), [], {
    env: {
      ...process.env,
      HOME: home,
      QQ_INSTALL_DIR: root,
      QQ_DATA_DIR: data,
      QQ_NODE: fakeNode,
      QQ_SERVICE: 'qq-agent-test',
      QQ_SNOWLUMA_WEBUI_URL: 'http://127.0.0.1:15099'
    }
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.deployment-node'), 'utf8'), `${fakeNode}\n`);
  // 同上：btrfs 上可能落成 0700，只断言不泄露给 group/other
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, '.deployment-node')).mode & 0o077, 0);
  const unit = fs.readFileSync(path.join(home, '.config/systemd/user/qq-agent-test.service'), 'utf8');
  assert.match(unit, /Environment="SNOWLUMA_WEBUI_URL=http:\/\/127\.0\.0\.1:15099"/);
  const updateUnit = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.service'),
    'utf8'
  );
  const updateTimer = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.timer'),
    'utf8'
  );
  assert.match(updateUnit, /scripts\/auto-update\.mjs/);
  // 更新器最坏预算（2026-10-07 复审重算）：入口探测 ≤2×(5×20s) + 目标解析 ≤(retries+1)×fetch
  // （默认 300s×4）+ 物化源码再一轮同量级 + npm ci 10min + 单测 20min + deploy.sh 20min ——
  // 默认设置下已 ~100min，fetchTimeoutSeconds/networkRetries 调大后数小时。unit 超时必须大于
  // 最坏预算，否则 systemd 会在 deploy.sh 中途（含回滚中）SIGKILL 整个 cgroup，
  // 留下半新半旧的安装目录且失败告警发不出去。
  assert.match(updateUnit, /TimeoutStartSec=240min/);
  assert.match(updateUnit, /TimeoutStopSec=10min/);
  assert.match(updateTimer, /OnUnitInactiveSec=1h/);
  assert.match(updateTimer, /RandomizedDelaySec=10min/);
  const deployment = JSON.parse(fs.readFileSync(path.join(root, '.deployment.json'), 'utf8'));
  assert.equal(deployment.updateService, 'qq-agent-test-update');
  assert.equal(deployment.repository, 'https://github.com/sakurawwwxh/qq-agent-plus.git');
  assert.equal(deployment.branch, 'main');

  const manage = spawnSync('/bin/bash', [path.join(root, 'manage.sh'), 'health'], {
    cwd: root,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8'
  });
  assert.equal(manage.status, 0, manage.stderr);
  assert.deepEqual(
    fs.readFileSync(capture, 'utf8').trim().split('\n'),
    ['scripts/manage.mjs', 'health']
  );
});

// Issue #15（2026-09-25）：unit 带 NoNewPrivileges 时重启后 sudo 必死，linger 步骤
// 一失败整个更新就回滚。linger 只影响下次开机自启，必须是尽力而为：先预检 NNP
// 别让 sudo 去撞内核限制，sudo 失败走警告分支（if/elif 保护，不触发 ERR 回滚）。
test('deploy script treats linger as best-effort and never rolls back over it', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(
    source,
    /loginctl show-user "\$USER" -p Linger --value 2>\/dev\/null \|\| true/,
    'loginctl 查询失败要当作"未开 linger"处理，不能让命令替换触发 ERR'
  );
  assert.match(
    source,
    /if grep -q 'NoNewPrivs:\[\[:space:\]\]\*1' \/proc\/self\/status/,
    '先预检 NoNewPrivileges：被加固时跳过 sudo，给出手动指引而不是内核报错'
  );
  assert.match(
    source,
    /elif ! sudo -n loginctl enable-linger "\$USER"/,
    'sudo 失败必须走 elif 警告分支，不能裸跑触发 ERR 回滚'
  );
  assert.match(source, /下次开机不会自启/, '警告要说明后果与手动补救命令');
});

test('deploy.sh 调用 verify-deployment-target.mjs（C7 强校验真实接入，不是摆设）', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(sh, /verify-deployment-target[.]mjs/, 'deploy.sh 应调用校验脚本');
  assert.match(sh, /DEPLOY_REPOSITORY/, 'deploy.sh 应支持 --repository 透传');
});

test('manage backup：所有 SQLite 库都走在线 backup API，不直接拷 WAL 文件', () => {
  const manage = fs.readFileSync(path.join(repo, 'scripts/manage.mjs'), 'utf8');
  assert.match(manage, /name\.endsWith\('\.sqlite'\)/);
  assert.match(manage, /isSqliteFile\(/,
    '后缀是 .sqlite 的普通文件不能当数据库打开，否则整次备份中断');
  assert.match(manage, /await backup\(db, dst\)/);
  assert.ok(manage.includes('/\\.sqlite-(wal|shm)$/'), 'WAL/SHM 不单独拷贝');
  assert.match(manage, /const copyTree = async/, '嵌套目录要递归，不能把 living-memory 等库裸拷贝');
  assert.match(manage, /function getCfg\(\)/, 'config.json 必须惰性读取，损坏时 stop/start 仍可用');
  assert.doesNotMatch(manage, /^const cfg = readJson/m, '不能在模块加载时强读 config.json');
});

test('凭据轮换时预检不再用旧 token 拦截', () => {
  const deploy = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  const check = fs.readFileSync(path.join(repo, 'scripts/check-stack-update.mjs'), 'utf8');
  assert.match(deploy, /QQ_AGENT_ALLOW_CREDENTIAL_ROTATION=1/);
  assert.match(check, /allowRotation/);
  assert.match(check, /if \(!allowRotation\)/);
});

test('deploy-all 默认只绑回环，--publish 才对外开放', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.match(source, /PUBLISH_HOST="127\.0\.0\.1"/, '默认必须是 127.0.0.1');
  assert.match(source, /--publish\) PUBLISH_HOST="0\.0\.0\.0"/, '--publish 才能切到 0.0.0.0');
  assert.match(source, /--loopback\) PUBLISH_HOST="127\.0\.0\.1"/, '--loopback 显式收回');
  assert.match(source, /"\$\{PUBLISH_HOST\}:\$\{NOVNC_PORT\}:6081"/, 'noVNC 用 PUBLISH_HOST');
  assert.match(source, /"\$\{PUBLISH_HOST\}:\$\{SNOWLUMA_WEBUI_HOST_PORT\}:5099"/, 'WebUI 用 PUBLISH_HOST');
  assert.match(source, /DEPLOY_ARGS\+=\(--host "\$PUBLISH_HOST"\)/, '控制台 host 跟随 PUBLISH_HOST');
  // 存量安装不能因为一次更新被改回回环；显式 --publish/--loopback 才允许改。
  assert.match(source, /if \[\[ "\$EXISTING_STACK" != true \|\| "\$PUBLISH_EXPLICIT" == true \]\]; then[\s\S]*?--host "\$PUBLISH_HOST"/s);
});

test('deploy-all.sh：栈级互斥锁覆盖 .env 到 deploy.sh 的全程，且失败方不删赢家的锁', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.match(sh, /acquire_stack_lock/);
  assert.match(sh, /STACK_LOCK_DIR="\$\{TMPDIR:-\/tmp\}\/qq-agent-deploy-/,
    '锁不能建在部署根：预检拒绝时要保持“什么都没创建”');
  assert.match(sh, /STACK_LOCK_DIR="\$\{TMPDIR:-\/tmp\}\/qq-agent-deploy-[^\n]*\ntrap deploy_all_exit EXIT/);
  assert.match(sh, /STACK_LOCK_OWNED=false/);
  assert.match(sh, /if \[\[ "\$\{STACK_LOCK_OWNED:-false\}" == true/,
    '只有锁的所有者才能删除锁');
  assert.match(sh, /acquire_stack_lock\ncheck_local_ownership/,
    '锁必须在归属判定之前拿到（防止并发重跑按 fresh 处理受管栈）');
  assert.match(sh, /STACK_LOCK_DIR\.takeover/, '陈旧锁接管要有互斥');
  assert.match(sh, /mv -- "\$STACK_LOCK_DIR" "\$takeover\/stale"/,
    '接管要先原子搬走旧锁，不能 rm -rf 后再 mkdir');
});

test('deploy.sh：共享目录判定在 realpath 之后，且离线时复用已装运行时', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const canonAt = sh.indexOf('INSTALL_CANON="$(canon_path');
  const caseAt = sh.indexOf('case "$INSTALL_CANON" in');
  assert.ok(canonAt > 0 && caseAt > canonAt, 'case 必须在归一化之后');
  assert.match(sh, /Reusing recorded Node\.js runtime/,
    '升级补丁版本时不能无视已记录的可用运行时');
});

test('deploy-all 生成的 compose 也带日志轮转（不等于仓库根目录那份）', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.match(
    sh,
    /container_name: "\$\{SNOWLUMA_CONTAINER\}"\n    restart: unless-stopped\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "3"\n/,
    '生成的 SnowLuma 服务必须限制 json-file 日志大小'
  );
});

test('deploy.sh：健康检查有单次超时和总 deadline', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(sh, /AbortSignal\.timeout\(2000\)/);
  assert.match(sh, /HEALTH_DEADLINE/);
});

test('deploy.sh：systemd 安装树不铺 Docker 全栈文件', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  for (const rule of [
    '--exclude=/docker-compose.yml',
    "--exclude='/docker-compose.*.yml'",
    '--exclude=/Dockerfile',
    '--exclude=/.dockerignore',
    '--exclude=/docker/',
    "--exclude='/scripts/docker-*.mjs'",
    "--exclude='/scripts/docker-*.sh'"
  ]) {
    assert.ok(sh.includes(rule), `deploy.sh 缺少 Docker 文件排除：${rule}`);
  }
});

test('deploy-all：已有安装重跑也把端口显式交给 deploy.sh', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  assert.match(sh, /DEPLOY_ARGS=\([^)]*--port "\$AGENT_PORT"\)/,
    '端口只在全新安装分支传：.env 已改成新端口、config.json 还是旧端口，健康检查必超时');
  assert.doesNotMatch(sh, /DEPLOY_ARGS\+=\(--host 0\.0\.0\.0 --port/, '新装分支不要重复追加端口');
});

test('deploy-all：栈级锁在归属判定与凭据读回之前获取', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  const lock = sh.indexOf('acquire_stack_lock\ncheck_local_ownership');
  assert.ok(lock >= 0, '锁必须紧接在 check_local_ownership 之前');
  assert.ok(sh.indexOf('acquire_stack_lock') < sh.indexOf('check_host_ownership'), 'host 预检也要在锁之后');
});

test('SnowLuma 自定义端口同时写进服务环境与部署记录', () => {
  const sh = fs.readFileSync(path.join(repo, 'deploy-all.sh'), 'utf8');
  const svc = fs.readFileSync(path.join(repo, 'scripts/install-service.mjs'), 'utf8');
  assert.match(sh, /export QQ_AGENT_WEBUI_PORT="\$SNOWLUMA_PORT"/);
  assert.match(svc, /QQ_AGENT_WEBUI_PORT=\$\{webuiPort\}/);
  assert.match(svc, /\.\.\.\(webuiPort \? \{ webuiPort \} : \{\}\)/);
});

test('manage.mjs：IPv6 host 写 URL 时加方括号', () => {
  const src = fs.readFileSync(path.join(repo, 'scripts/manage.mjs'), 'utf8');
  assert.match(src, /host\.includes\(':'.*?\) host = `\[\$\{host\}\]`/s);
  assert.match(src, /rawHost === '::'/);
});
