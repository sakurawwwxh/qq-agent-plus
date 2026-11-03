// 2026-10-09 全面审查里修掉的缺陷的**跨文件守卫用例**（行为用例在各自文件里，
// 这里只放源码锚点/不变量 —— 与 review-2026-10-08-round3 同一分工）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

test('租约回收的竞态守门：两处调用点都带 liveLeases，且 store 真的按 live 跳过', () => {
  // 2026-10-09 审查：recoverExpired 的 `live` 过滤是"在跑执行不再被回收"的唯一守门，
  // 而此前全仓没有任何用例引用过它（测试里 grep 不到 liveLeases）—— 删掉守卫测试照样全绿。
  const orch = read('src/core/orchestrator.js');
  const calls = orch.match(/recoverExpired\([^\n]*live: this\.liveLeases[^\n]*\)/g) || [];
  assert.ok(calls.length >= 2, `两处 recoverExpired 调用都要带 { live: this.liveLeases }，实际 ${calls.length} 处`);
  const store = read('src/core/store.js');
  assert.ok(/if \(live && live\.has\(run\.id\)\) continue;/.test(store),
    'store.recoverExpired 里必须真的按 live 跳过 —— 否则调用点传了也白搭');
});

test('运行台账（runs）进了每日保留期清理，且启动路径与调度共用 store.pruneRuns 一个口径', () => {
  // 2026-10-09 审查：runs 原来只在 ChatStore 构造时清一次，连跑数月 = 永不清理。
  const app = read('src/console/app.js');
  assert.ok(/name: '运行台账', run: \(\) => store\.pruneRuns\(\)/.test(app),
    'retentionPruneTargets 必须包含运行台账');
  const store = read('src/core/store.js');
  assert.ok(/this\.pruneRuns\(\);/.test(store), '启动路径复用同一方法');
  assert.ok(/DELETE FROM runs WHERE state != 'leased' AND expires_at <= \?/.test(store),
    '只清终态且过期的行；leased 行归 recoverExpired 管');
});

test('NNP（NoNewPrivileges）三个口径修正都在：先判再试 / 巡检不假绿 / 文档不再承诺捷径', () => {
  // 2026-10-09 审查：标准 unit 默认带 NNP，sudo 回退必失败 —— "有免密 sudo 就能用"是错的。
  const updater = read('src/core/snowluma-update.js');
  assert.ok(/if \(hasNoNewPrivs\(\)\) \{/.test(updater),
    'runDocker 必须先判 NNP，再决定要不要试 sudo');
  assert.ok(/processHasNoNewPrivs/.test(updater));
  const health = read('src/core/health-check.js');
  assert.ok(/mainServiceHasNoNewPrivs/.test(health), '巡检要读主进程的 NNP 状态');
  assert.ok(/noNewPrivsStatus \?\? mainServiceHasNoNewPrivs\(service\)/.test(health),
    '加固时不许拿巡检进程自己的 sudo 结果当"能用"的证据');
  const linux = read('docs/LINUX.md');
  assert.equal(/不必先重启\s*user manager/.test(linux), false,
    '文档不许再承诺"有免密 sudo 就能用、不必重启 user manager"');
  assert.ok(/NoNewPrivileges/.test(linux), '文档要说明默认配置带加固');
});

test('随版本对齐并入更新流程：挂在启动首检、默认开、override 优先（2026-10-09）', () => {
  // 语义：协议端基线是代码常量、只随 Agent 新版本到达用户机器 —— 更新 Agent 后主服务带新
  // 代码重启是看到新基线的唯一时刻；在启动首检做一次对齐 = "我们发版动了协议端就顺带对齐"。
  const app = read('src/console/app.js');
  assert.ok(/if \(first\) await snowlumaBaselineAlign\(\);/.test(app),
    '启动首检（first）要先做一次随版本对齐');
  assert.ok(/followBaseline: cfgNow\.autoUpdate\?\.snowluma\?\.followBaseline !== false/.test(app),
    '默认开：只有显式 false 才关（!== false 语义）');
  const core = read('src/core/snowluma-update.js');
  assert.ok(/export function baselineAlignDecision/.test(core), '决策函数在 core 层（可单测）');
  const uiSettings = read('ui/pages/settings.js');
  assert.ok(/id="cfg-snowluma-follow-baseline"/.test(uiSettings), '设置页要有「随版本对齐」开关');
  // 精确到同一行：缺键（undefined）→ 勾选（2026-10-09 审查：原来的宽正则能匹配任意一行）
  assert.ok(/id="cfg-snowluma-follow-baseline"[^>]*\$\{c\.autoUpdate\?\.snowluma\?\.followBaseline === false \? '' : 'checked'\}/.test(uiSettings),
    '开关默认勾选（缺键即勾选）');
  const uiSave = read('ui/pages/settings-save.js');
  assert.ok(/followBaseline: chk\('#cfg-snowluma-follow-baseline'/.test(uiSave), '开关要能被保存');
});

test('协议端基线只有一份真源：core 常量与 deploy-all.sh 的镜像串必须同步', async () => {
  // 升级基线时要改的就是这些地方（core 常量 + 部署脚本里的镜像串）——这条条件替我们核对，
  // 忘了同步会直接红（2026-10-09 审查建议：本仓有"第二份真源必须锚住"的惯例）。
  const { SNOWLUMA_BASELINE_IMAGE } = await import('../src/core/snowluma-update.js');
  const tag = String(SNOWLUMA_BASELINE_IMAGE).split(':').pop();
  assert.ok(tag, '基线常量要带 tag');
  const deployAll = read('deploy-all.sh');
  assert.ok(deployAll.includes(`snowluma:${tag}`), `deploy-all.sh 里应引用当前基线 snowluma:${tag}`);
});

test('设计标度只有一份 CSS 真源：主题块不许再重复定义 --r-*（2026-10-09 复核）', () => {
  // 暗色块里曾残留圆角三档与刻度默认：同特异性下后出现的 :root 覆盖了它们 → 全是死声明，
  // 且 --r-lg 死值 14px / 生效值 12px —— 改主题块那份会"改了没反应"（复核时发现）。
  const css = read('ui/style.css');
  // ⚠️ 锚点别用注释文本：read() 会把 /* */ 剥成空格（这次就踩了——模式里的 `/* 间距`
  // 在剥注释后的文本里不存在）。用变量定位，顺带把 CRLF 也容忍掉。
  const darkMatch = /\[data-theme='dark'\]\s*\{([\s\S]*?)\r?\n\}/.exec(css);
  assert.ok(darkMatch, '找不到暗色主题块');
  assert.equal(/--r-(sm|md|lg|input|card|xl):/.test(darkMatch[1]), false,
    '暗色块不许再重复定义圆角标度（真源在 :root）');
  // 刻度兜底在 :root 设计标度节里：位置必须在 --sp-1 之后（跑回主题块就是位序倒了）
  assert.ok(/--r-scale:\s*1;/.test(css) && /--zoom:\s*1;/.test(css));
  const spIdx = css.indexOf('--sp-1:');
  const scaleIdx = css.indexOf('--r-scale: 1;');
  assert.ok(spIdx > 0 && scaleIdx > spIdx, '--r-scale 兜底要落在 :root 设计标度节里（--sp-1 之后）');
});

test('标度收口不许倒退：style.css 里没有裸 font-size/border-radius 像素值（2026-10-09 复核）', () => {
  // 收口（31565f0）把 323 处字号、139 处圆角全部改走 token；这条锚点防"下一个人又写裸值"，
  // 也防"token 化改到了死副本"（本仓已两次踩死声明）。允许：token 定义行（--fs-*: 10px /
  // --r-*: calc(8px * …)）与几何值（50% / 0 / var()）。
  const css = read('ui/style.css');
  const bare = css.split('\n')
    .filter((l) => !/^\s*--[a-z-]+:/.test(l))                       // token 定义行豁免
    .filter((l) => /(font-size|border-radius):\s*[0-9.]+px/.test(l));
  assert.deepEqual(bare, [], `不许再出现裸像素值（走 --fs-* / --r-*）：\n${bare.join('\n')}`);
});

test('JS 里引用的 CSS 变量必须存在（无 fallback 的坏名 = 静默失效）（2026-10-09 复核）', () => {
  // 复核抓到两个坏名：memory.js 的 --color-background-warning（无定义无兜底 → 声明失效变 unset，
  // 白字贴透明底看不见）、global-memory.js 的 --border-color/--hover-bg（永远走写死的兜底灰、
  // 不跟主题）。这条锚点把"无 fallback 的引用必须在 style.css / index.html / JS 的 setProperty
  // 写入里出现过"钉住（主题波纹的 --vt-* 就是运行时写入的，所以 JS 写入要算定义源）。
  const jsFiles = [
    'ui/app.js', 'ui/global-memory.js', 'ui/multimodal-context-pilot.js',
    'ui/relationship-pilot.js', 'ui/session-memory-view.js',
    ...fs.readdirSync(new URL('../ui/pages', import.meta.url)).map((f) => `ui/pages/${f}`),
    ...fs.readdirSync(new URL('../ui/core', import.meta.url)).map((f) => `ui/core/${f}`)
  ].filter((f) => f.endsWith('.js'));
  const sources = new Map(jsFiles.map((f) => [f, read(f)]));
  const defined = new Set();
  const staticCss = read('ui/style.css') + read('ui/index.html');
  for (const m of staticCss.matchAll(/--([a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const m of staticCss.matchAll(/setProperty\(\s*'--([a-z0-9-]+)'/g)) defined.add(m[1]);
  // JS 自身的 setProperty 写入也算定义（theme-transition 的 --vt-* 就是过渡时动态写的）
  for (const src of sources.values()) {
    for (const m of src.matchAll(/setProperty\(\s*'--([a-z0-9-]+)'/g)) defined.add(m[1]);
  }
  const bad = [];
  for (const [f, src] of sources) {
    // ⚠️ 剥掉行注释再扫：验证注释里写旧变量名（如 --color-background-warning）不该命中
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    for (const m of code.matchAll(/var\(--([a-z0-9-]+)\s*\)/g)) {   // 只认无 fallback 的形式
      if (!defined.has(m[1])) bad.push(`${f}: --${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(bad)], [], `引用了不存在的 CSS 变量（换成真实 token 或加兜底）：\n${bad.join('\n')}`);
});

test('值班台两级表面落地：kpi 发丝线/panel 细线不被卡片组覆盖；折射环挂整行表面（2026-10-09 复核）', () => {
  const css = read('ui/style.css');
  // ① .kpi 的发丝线、.panel 的"细线分节"要真的生效：卡片组（--shadow-card / --r-card）不许再收它们
  assert.ok(/\.kpi \{[^}]*box-shadow: -1px 0 0 var\(--border\), 0 -1px 0 var\(--border\)/.test(css),
    '.kpi 的发丝线分格声明要在');
  assert.ok(/\.usage-card, \.tool-card,[^}]*box-shadow: var\(--shadow-card\)/.test(css),
    '卡片组还在（剩下的卡片）');
  assert.equal(/\.kpi, \.panel, \.usage-card/.test(css), false,
    '.kpi/.panel 不许回到卡片组（会把发丝线与细线分节整条覆盖掉）');
  // ② 折射环清单要跟表面清单一致：挂 .kpi-grid（整行），不再给每格或 .panel 挂环
  const refractAfter = /html\[data-glass='liquid'\] #topbar::after[\s\S]{0,1500}?mask-composite: exclude;/.exec(css);
  assert.ok(refractAfter, '找不到折射环清单');
  assert.ok(/\.kpi-grid::after/.test(refractAfter[0]), '环要挂在整行表面 .kpi-grid 上');
  assert.equal(/\.kpi::after/.test(refractAfter[0]), false, '不许再给每格 .kpi 挂环（嵌套 backdrop-filter）');
  assert.equal(/\.panel::after/.test(refractAfter[0]), false, '.panel 横向内边距为 0，环会压字，不挂');
  // ③ JS 的折射选择器与 CSS 清单一致
  const refractJs = read('ui/core/glass-refract.js');
  assert.ok(/'\.kpi-grid'/.test(refractJs), '折射选择器要含 .kpi-grid');
  assert.equal(/'\.kpi'/.test(refractJs), false, '折射选择器不许再有 .kpi（白算 + 占名额）');
});

test('deploy-all 轮换失败不再假回滚：保持三方凭据一致，trap 尊重旗标', () => {
  // 2026-10-09 审查：回拷 .env 会把"config.json/compose 是新凭据"搞成不一致，
  // 下次部署被自家预检拒、新控制台令牌只剩 config.json 一份。
  const sh = read('deploy-all.sh');
  assert.ok(/KEEP_ENV_ON_ROTATE_FAILURE=true/.test(sh), '轮换失败要立旗标');
  assert.ok(/\$\{KEEP_ENV_ON_ROTATE_FAILURE:-false\}" != true/.test(sh), '退出 trap 要尊重旗标、别再回拷 .env');
  assert.equal(/cp -p "\$ENV_FILE\.pre-deploy" "\$ENV_FILE"\n\s*die 'SnowLuma password rotation/.test(sh), false,
    '不许再"回拷 .env 后 die"');
});

test('test-suite 兜底清理不碰运行中服务的 tmp 目录前缀', () => {
  // 2026-10-09 审查：在部署机上跑 npm test 时，兜底清理会删掉服务正在用的 ffmpeg 工作目录。
  const suite = read('scripts/test-suite.mjs');
  assert.ok(/RUNTIME_TMP_PREFIXES/.test(suite));
  assert.ok(/'qq-ffmpeg-'/.test(suite) && /'qq-ffprobe-'/.test(suite));
  assert.ok(/RUNTIME_TMP_PREFIXES\.some\(\(p\) => entry\.name\.startsWith\(p\)\)\) continue;/.test(suite),
    '清理循环里要真的跳过这些前缀');
});

test('禁言文案的日期与时刻同口径（都走上海时区，TZ=UTC 部署不再差一天）', () => {
  // 2026-10-09 审查：muteError 用本地时区 getMonth()/getDate() 取日期，formatClockTime 却是
  // 上海时区 —— 部署在 TZ=UTC 的机器上，北京 0-8 点之间解禁日期会报错一天。
  const sender = read('src/onebot/sender.js');
  assert.ok(/const dayKey = todayKey\(untilTs\);/.test(sender), '日期要走 todayKey（上海口径）');
  assert.ok(/dayKey === todayKey\(\)/.test(sender), '"是否同一天"也要同口径');
  assert.equal(/until\.getMonth\(\)|until\.getDate\(\)/.test(sender), false,
    '不许再用本地时区的 getMonth()/getDate()');
});

test('readBounded 的 truncated 由读取路径给出（> 而非 >=，边界不误标）', () => {
  // 2026-10-09 审查：正好等于上限的完整响应被 >= 误标 truncated；截断后的英文页长度
  // 恰好也是上限，拿长度反推又会漏标 —— 标记必须来自"是否真的中断"。
  const sf = read('src/llm/safe-fetch.js');
  assert.ok(/if \(total > maxBytes\) \{/.test(sf), '中断条件是 > 不能是 >=');
  assert.ok(/truncated: true,/.test(sf) && /truncated: false,/.test(sf));
  assert.equal(/Buffer\.byteLength\(body, 'utf8'\) >= 50000/.test(sf), false,
    '不许再拿 body 长度反推 truncated');
});

test('docker 组自愈做进了部署收尾：加组 + stop→sleep→start 重建（systemd 发行版通用件）', () => {
  // Issue #30 的根因之一：标准部署从不碰 docker 组成员关系 —— 控制台「更新协议端」
  // 从第一天起就报权限不足。收尾里把"加组 + 让管理器读到"都做掉（2026-10-09）。
  const sh = read('deploy.sh');
  assert.ok(/sudo usermod -aG docker/.test(sh), '要把部署用户加进 docker 组（显式 opt-in 后）');
  assert.ok(/QQ_AGENT_ALLOW_DOCKER_GROUP/.test(sh), '加组必须显式 opt-in，不能默认把控制台抬到宿主 root');
  assert.ok(/sudo -n systemctl stop "\$MANAGER_UNIT"/.test(sh),
    '重建要先 stop —— restart 会撞 status=219/CGROUP（cgroup 回收竞态，实测）');
  assert.ok(/sleep 3/.test(sh) && /sudo -n systemctl start "\$MANAGER_UNIT"/.test(sh),
    'stop 之后留回收间隔、再单独 start');
  assert.equal(/systemctl restart [^\n]*(MANAGER_UNIT|user@)/.test(sh), false,
    '不许用 restart 重建管理器：实测（systemd 249）219/CGROUP 失败后不会自动回来（服务停摆到人工 start）');
  // 自动更新场景必须跳过重建：无人值守时不做停服动作（位置序：分流判断在 stop 之前）
  const heal = sh.indexOf('# ── docker 组自愈');
  const skipBranch = sh.indexOf('if [[ "$DOCKER_MEMBER" == true && -z "${QQ_AGENT_SOURCE_REVISION:-}" ]]; then', heal);
  const stopPos = sh.indexOf('sudo -n systemctl stop "$MANAGER_UNIT"', heal);
  assert.ok(heal > 0 && skipBranch > heal && stopPos > skipBranch,
    '自动更新（QQ_AGENT_SOURCE_REVISION 有值）要在重建动作之前分流跳过');
  // 自愈块必须在"部署已成功之后的收尾"段里（trap - ERR 之后）：失败不许改动退出码
  const cleanup = sh.indexOf('trap - ERR INT TERM');
  assert.ok(cleanup > 0 && heal > cleanup, '自愈块要在收尾段（尽力而为、不改退出码）');

  // 2026-10-09 复核（两条都是这个块自己引入的隐患）：
  const healEnd = sh.indexOf("printf '\\nConsole:", heal);
  assert.ok(healEnd > heal, '自愈块后面应是 Console 提示行');
  const healBlock = sh.slice(heal, healEnd);
  // ① 真正被执行的 sudo 一律要带 -n：这些调用的 stdout/stderr 都被丢弃了，一旦 sudo 要密码，
  //    提示会被 2>/dev/null 吞掉、部署看起来像卡死（用户只能盲输或 Ctrl+C）。
  //    printf 里那几句是给用户自己敲的（人工交互可以输密码），不算。
  const bareSudo = healBlock.split('\n')
    .filter((l) => !/printf/.test(l) && /^\s*(if |\|\| )?sudo (?!-n )/.test(l));
  assert.deepEqual(bareSudo, [],
    `自愈块里执行的 sudo 必须带 -n（否则密码提示被吞、表现为卡死）：${bareSudo.join(' | ')}`);
  // ② 重试 start 之前要再等一次：那次失败通常正是 219/CGROUP（旧实例 cgroup 还没回收），
  //    紧接着重试会撞同一个竞态、白试一次。
  const firstStart = healBlock.indexOf('sudo -n systemctl start');
  const secondStart = healBlock.indexOf('sudo -n systemctl start', firstStart + 1);
  assert.ok(firstStart > 0 && secondStart > firstStart, 'start 失败要有一个重试');
  assert.ok(healBlock.slice(firstStart, secondStart).includes('sleep 3'),
    '重试之前要再留一次回收间隔（219/CGROUP 竞态），否则重试没有意义');
  assert.ok((healBlock.match(/sleep 3/g) || []).length >= 2,
    'stop 之后与重试之前都要有间隔（期望 ≥2 处 sleep 3）');
});

test('ops console --open：cmd 元字符守卫要覆盖完整（2026-10-09 复核）', () => {
  // cmd.exe 的元字符不止 & | ^ < > " —— `%VAR%` 会在分词之后**又展开一次**，展开结果里的
  // 元字符会被重新解析（实测 `set X=^&calc` 再 `echo %X%` 真的会执行 calc），`!` 是延迟展开的
  // 同一类风险；CR/LF/TAB 则直接断开命令行。少挡一个就等于没挡。
  const ops = read('src/ops.js');
  const m = ops.match(/if \(IS_WINDOWS && \/\[([^\]]*)\]\//);
  assert.ok(m, '找不到 openBrowser 里的 cmd 元字符守卫（改名/改写法时同步本条）');
  const cls = m[1];
  for (const ch of ['"', '&', '|', '^', '<', '>', '%', '!']) {
    assert.ok(cls.includes(ch), `守卫字符集缺 ${ch}`);
  }
  for (const esc of ['\\r', '\\n', '\\t']) {
    assert.ok(cls.includes(esc), `守卫字符集缺 ${esc}（源码里应是反斜杠转义写法）`);
  }
});

test('terminate-user 与 restart user@ 两颗雷都拆干净了：提示与文档都不再当修复手段', () => {
  // 2026-10-09 实测（systemd 249）两颗雷：terminate-user 后管理器不会自动重建（服务停到下次登录）；
  // restart user@ 撞 status=219/CGROUP 同样不会自动回来。教用户照做 = 把机器人弄停。
  const js = read('src/core/snowluma-update.js');
  assert.equal(/sudo loginctl terminate-user/.test(js), false,
    'DOCKER_SOCKET_HINT 不许再把 terminate-user 当修复步骤');
  assert.equal(/sudo systemctl restart user@/.test(js), false,
    'restart user@ 也不许当修复命令（给 stop/sleep/start）');
  assert.ok(/sudo systemctl stop user@/.test(js) && /sudo systemctl start user@/.test(js));
  const md = read('docs/LINUX.md');
  assert.equal(/sudo loginctl terminate-user/.test(md), false);
  assert.equal(/sudo systemctl restart user@/.test(md), false);
  assert.ok(/不要用\s*`?systemctl restart user@/.test(md), '文档要写明为什么不用 restart user@');
  assert.ok(/不要用\s*`?loginctl terminate-user/.test(md), '文档要写明为什么不用 terminate-user');
});
