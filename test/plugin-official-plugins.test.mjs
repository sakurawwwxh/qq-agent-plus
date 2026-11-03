// 官方插件（examples/plugins/ 下全部）的验收用例。
//
// 这组用例回答三件事：
//   ① 每个 manifest 能不能过宿主那套 fail-closed 校验，联网的有没有声明 http 能力；
//   ② 插件有没有"自己发请求"——必须经宿主的 cap.http.request 那条路（才有内网拦截/体积上限/审计）；
//   ③ 参数校验是不是**在发请求之前**（坏参数本地就该报掉，不该拿它去打上游）。
//
// ⚠️ 后两条**真起子进程**（用与生产同一套 PluginHost），不 mock：隔离/守卫/协议只有真起进程
// 才测得到。为了让用例**不打真实网络**，网络相关的断言一律靠"把数据源指到内网地址、让宿主
// 侧的网络守卫拦下"来证明 —— 既验了守卫真的在，又不碰外网（见 docs/PLUGINS.md 的宿主侧纪律）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 与 test/plugins.test.mjs 同一套做法：数据目录指到临时目录，退出时清掉
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-official-plugins-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { parsePluginManifest, SUPPORTED_API_VERSIONS } = await import('../src/plugins/manifest.js');
const { PluginHost } = await import('../src/plugins/host.js');

// 通用护栏（manifest 合法 / 不自己发请求 / 请求都走 cap.http.request）对**全部官方插件**跑，
// 清单直接来自 plugins/official-packages.json —— 那是"哪些插件算官方"的唯一来源，也是
// "改了源码忘了重打包"的锚。好处：新加一个 examples/plugins/<id> 就必须补一条锚（否则
// test/plugin-index.test.mjs 会红），补了锚就自动被这三条护栏覆盖，不会漏。
const ANCHORS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'plugins', 'official-packages.json'), 'utf8'));
const IDS = Object.keys(ANCHORS.packages || {}).sort();
// 这五个是本轮新增的（有自己的坏参数/守卫用例）；它们在 IDS 里也要在，两边不许漂移
const NEW_IDS = ['translate', 'hot-topics', 'exchange-rate', 'ip-info', 'rss'];
const dirOf = (id) => path.join(process.cwd(), 'examples', 'plugins', id);

/** 读 manifest 并断言它合法（dir 用绝对路径 —— 校验要拿它验 entry 不越界）。 */
function manifestOf(id) {
  const dir = dirOf(id);
  const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { dir });
  assert.equal(parsed.ok, true, `${id} 的 manifest 必须合法：${parsed.error}`);
  return parsed.manifest;
}

/** 起一个真宿主；用完由调用方 stop（或交给 t.after）。 */
async function startHost(id, settings = {}, options = {}) {
  const host = new PluginHost({
    ...options,
    manifest: manifestOf(id),
    dataDir,
    log: () => {},
    getSettings: () => settings
  });
  assert.equal(await host.start(), true, `${id} 起不来：${host.lastError}`);
  return host;
}

test('官方插件：manifest 合法，id 与目录名一致，联网的都声明了 http 能力', () => {
  // 2026-10-16 下架 mc-status（与内置能力重复度低但实用性也低：只有跑 MC 服的人用得上）
  assert.ok(IDS.length >= 7, `官方插件至少 7 个（实际 ${IDS.length}）`);
  for (const id of NEW_IDS) assert.ok(IDS.includes(id), `${id} 必须在这份清单里（两处清单不许漂移）`);
  for (const id of IDS) {
    const manifest = manifestOf(id);
    assert.equal(manifest.id, id, 'id 必须与目录名一致');
    assert.ok(SUPPORTED_API_VERSIONS.includes(manifest.apiVersion), `apiVersion 必须是宿主支持的 ${SUPPORTED_API_VERSIONS.join('/')}`);
    assert.ok(manifest.tools.length >= 1, `${id} 至少要声明一个工具（否则装上也没用）`);
    // 这五个都要联网；漏声明 http 的运行期表现是"越权被拒"，装的时候就要发现
    assert.ok(manifest.capabilities.includes('http'), `${id} 要联网就必须声明 http 能力`);
    assert.ok(manifest.capabilities.includes('tools'), `${id} 声明了工具就得带上 tools 能力`);
  }
});

test('官方插件：不自己发请求（没有裸 fetch、没直接开 http(s)，且请求都走 cap.http.request）', () => {
  for (const id of IDS) {
    const src = fs.readFileSync(path.join(dirOf(id), 'index.mjs'), 'utf8');
    // 这条是"插件不许自己发请求"的护栏：走宿主那条路才有内网拦截/体积上限/超时/审计
    assert.ok(!/\bfetch\s*\(/.test(src), `${id} 不许自己 fetch（要联网只能经宿主的 cap.http.request）`);
    assert.ok(
      !/require\(['"]https?['"]\)|from\s+['"]node:https?['"]|require\(['"]node:https?['"]/.test(src),
      `${id} 不许直接 require/import http(s) 模块`
    );
    assert.ok(src.includes('cap.http.request'), `${id} 的请求必须走 cap.http.request`);
  }
});

test('hot-topics 真起子进程：把数据源指到内网，宿主侧的网络守卫必须拦下（用例不打真网络）', async (t) => {
  // 把 V2EX 热帖地址指到本机 —— 宿主侧的 safe-fetch 会拦下它。这同时证明了两件事：
  //   · 守卫真的在（插件拿不到"自己发请求"的能力就跑不到上游）；
  //   · 插件确实是经宿主出的网（它自己发的话根本不会经过这道守卫，也就不会有这个报错）。
  const host = await startHost('hot-topics', { v2exUrl: 'http://127.0.0.1:9/hot.json' });
  t.after(() => host.stop());
  await assert.rejects(
    () => host.callTool('list', { source: 'v2ex' }),
    /内网|本机/,
    '内网地址必须被宿主侧的网络守卫拦下'
  );
});

test('官方插件（本轮新增的五个）：坏参数在**发请求之前**就被拦下（不拿坏参数去打上游）', async (t) => {
  // 网络错误的字样：坏参数这条路上**不该**出现这些。出现了就说明它真的去打了上游
  //（用例会因此变红，同时也会去碰外网 —— 这在本仓的测试纪律里是不允许的）。
  const NETWORK_NOISE = /内网|本机|HTTP \d|超时|timed out|timeout|ENETUNREACH|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|网络/i;

  // 每个插件的"坏参数"：缺必填、或必填给了空串。hot-topics 没有必填参数，就用"传了但为空"的来源。
  const cases = [
    { id: 'translate', tool: 'text', args: {} },
    { id: 'translate', tool: 'text', args: { text: '   ' } },          // 空白字符串等于没给
    { id: 'hot-topics', tool: 'list', args: { source: '' } },
    { id: 'exchange-rate', tool: 'convert', args: {} },
    { id: 'exchange-rate', tool: 'convert', args: { amount: '', from: '', to: '' } },
    { id: 'ip-info', tool: 'lookup', args: {} },
    { id: 'ip-info', tool: 'lookup', args: { query: '' } },
    { id: 'rss', tool: 'latest', args: {} },
    { id: 'rss', tool: 'latest', args: { url: '' } }
  ];

  const hosts = new Map();
  t.after(async () => { for (const host of hosts.values()) await host.stop(); });
  for (const item of cases) {
    let host = hosts.get(item.id);
    if (!host) {
      host = await startHost(item.id);
      hosts.set(item.id, host);
    }
    const result = await host.callTool(item.tool, item.args);
    const message = String(result?.error ?? '');
    // 插件用"结果里的 error 字段"如实报错（不是抛异常）：模型与用户都靠它判断
    assert.ok(message.length > 0,
      `${item.id}.${item.tool}(${JSON.stringify(item.args)}) 坏参数要给非空 error，实际 ${JSON.stringify(result)}`);
    assert.ok(!NETWORK_NOISE.test(message),
      `${item.id}.${item.tool} 的坏参数报错里不该有网络字样（说明它没去打上游）：${message}`);
  }
});

// 2026-10-24：B 站插件补"主人 UID 绑定"（humanism 同款 nav.mid 核对）与一键三连。
// 行为要真网络没法在 CI 里跑，这里锚住契约与"写入口统一走 requireWriteAuth"，
// 防止以后新增写工具绕过主人核对。
test('B站插件：主人 UID 绑定、whoami 与一键三连已声明，所有写入口走 requireWriteAuth', () => {
  const manifest = manifestOf('bilibili');
  const account = (manifest.settings?.groups || []).find((group) => group.key === 'account');
  assert.ok(account, '要有 account 设置组');
  const owner = (account.fields || []).find((field) => field.key === 'ownerMid');
  assert.ok(owner, 'account 组要有 ownerMid（主人 B 站 UID）设置项');
  assert.equal(owner.type, 'text');

  const interact = manifest.tools.find((tool) => tool.name === 'interact');
  assert.ok(interact.parameters.properties.action.enum.includes('triple'), 'interact 要支持 triple 一键三连');
  const accountTool = manifest.tools.find((tool) => tool.name === 'account');
  assert.ok(accountTool.parameters.properties.what.enum.includes('whoami'), 'account 要支持 whoami');
  assert.ok(accountTool.parameters.properties.what.enum.includes('notifications'), 'account 要支持 notifications（未读回复/@/赞）');
  const commentTool = manifest.tools.find((tool) => tool.name === 'comment');
  assert.ok(commentTool.parameters.properties.rpid, 'comment 要支持 rpid（内联回复具体评论）');
  assert.equal(manifest.version, '1.1.1');
  for (const name of ['video', 'danmaku']) {
    assert.equal(manifest.tools.find((tool) => tool.name === name)?.timeoutMs, 30000,
      `${name} 走短链时可能先跟随一次重定向，默认 20 秒太紧`);
  }
  const danmakuTool = manifest.tools.find((tool) => tool.name === 'danmaku');
  assert.equal(danmakuTool.parameters.properties.text, undefined, 'danmaku 只读，发送参数应只在 danmaku_send');
  assert.equal(danmakuTool.parameters.properties.progressMs, undefined, 'danmaku 只读，时间参数应只在 danmaku_send');
  const loginTool = manifest.tools.find((tool) => tool.name === 'login');
  assert.equal(loginTool.parameters.properties.channel, undefined,
    'channel 必须由宿主 context 注入，不能作为模型可控参数');

  const src = fs.readFileSync(path.join(dirOf('bilibili'), 'index.mjs'), 'utf8');
  assert.match(src, /async function requireWriteAuth/, '要有统一的写操作鉴权（登录 + 主人 UID 核对）');
  assert.match(src, /navIdentity/, '主人核对要用 nav 读平台实际登录身份，不能只信 Cookie');
  assert.match(src, /senderIsOwner/, '聊天内扫码登录/退出要校验发起者是管理员');
  assert.match(src, /action !== 'poll'/, '控制台轮询 poll 要豁免管理员判定（issue #21）');
  assert.match(src, /context?.channel/, '插件要接受宿主传入的 channel=console');
  assert.match(src, /E_WRITE_UNKNOWN/, '写请求 5xx/超时/非 JSON 要标记结果未知');
  assert.match(src, /mergeLoginTokens/, '登录凭据要合并 URL 与 Set-Cookie');
  assert.match(src, /linkTimestamps/, '评论时间戳链接能力要在源码里');
  assert.match(src, /x\/msgfeed/, '通知收件箱要读 B 站消息中心');
  assert.match(src, /maxChars:\s*64\s*\*\s*1024,\s*decompress:\s*true/,
    '短链最终页会无视 identity 返回 gzip，必须让宿主有界解压后再找 canonical');
  const writeEntries = src.match(/await requireWriteAuth\(\)/g) || [];
  assert.ok(writeEntries.length >= 3, `interact/comment/danmaku_send 都要走 requireWriteAuth，实际 ${writeEntries.length} 处`);
  const loginCalls = src.match(/await requireLogin\(\)/g) || [];
  assert.equal(loginCalls.length, 1, '只有 requireWriteAuth 内部还能直接用 requireLogin');
});

test('B站插件：只读视频工具接受完整链接和 b23.tv 短链，非法 URL 不发请求', async (t) => {
  const bvid = 'BV1xx411c7mD';
  const calls = [];
  const viewBody = JSON.stringify({
    code: 0,
    data: {
      aid: 170001,
      bvid,
      cid: 42,
      title: '合成视频',
      desc: '仅用于契约测试',
      owner: { name: '合成 UP', mid: 7 },
      duration: 90,
      pubdate: 1,
      stat: { view: 1, like: 1, coin: 1, favorite: 1, danmaku: 1, reply: 1 },
      pages: [{ page: 1, cid: 42, part: 'P1', duration: 90 }]
    }
  });
  const host = await startHost('bilibili', {}, {
    httpMock: async ({ url }) => {
      calls.push(url);
      if (url === 'https://b23.tv/AbCdEf1') {
        return {
          status: 200,
          body: `<html><head><link rel="canonical" href="https://www.bilibili.com/video/${bvid}/"></head></html>`
        };
      }
      if (url.startsWith('https://api.bilibili.com/x/web-interface/view?')) {
        return { status: 200, body: viewBody };
      }
      throw new Error(`测试出现了未预期的 HTTP 请求：${url}`);
    }
  });
  t.after(() => host.stop());

  const direct = await host.callTool('video', {
    bvid: `https://www.bilibili.com/video/${bvid}/?p=2&share_source=qq`,
    withComments: false,
    withSubtitles: false
  });
  assert.equal(direct.bvid, bvid);
  assert.deepEqual(calls, [`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`],
    '完整视频 URL 应直接归一化，不应请求短链页');

  calls.length = 0;
  const short = await host.callTool('video', {
    bvid: 'https://b23.tv/AbCdEf1',
    withComments: false,
    withSubtitles: false
  });
  assert.equal(short.bvid, bvid);
  assert.deepEqual(calls, [
    'https://b23.tv/AbCdEf1',
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`
  ]);

  calls.length = 0;
  await assert.rejects(
    () => host.callTool('video', {
      bvid: 'https://evil.example/video/BV1xx411c7mD',
      withComments: false,
      withSubtitles: false
    }),
    /需要 BV 号/
  );
  assert.deepEqual(calls, [], '非法主机必须在宿主 HTTP 之前被拒绝');
});

test('B站插件：模型伪造 channel=console 不能绕过管理员；私人账号数据要求 owner', async (t) => {
  const host = await startHost('bilibili');
  t.after(() => host.stop());
  await assert.rejects(
    () => host.callTool('login', { action: 'start', channel: 'console' }, {
      context: { chatKey: 'private:12345', senderIsOwner: false }
    }),
    /只有管理员/,
    'channel 只能由宿主 context 设置，模型参数不能冒充控制台'
  );
  await assert.rejects(
    () => host.callTool('account', { what: 'history' }, {
      context: { chatKey: 'group:12345', senderIsOwner: false }
    }),
    /只有管理员/,
    '历史/收藏/关注/通知是管理员私人数据'
  );
});
