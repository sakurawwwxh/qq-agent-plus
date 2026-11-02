// 配置读取 / 保存 / 重载路由（从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 这是全站最大的写接口（约 600 行）：密钥归属钉、__replace__ 语义、hasXxx 回填、
// 保存失败回滚都在原处逐字保留 —— 拆分只搬位置，不改逻辑。
import fs from 'node:fs';
import path from 'node:path';
import {
  reloadConfig, conversationConfigForChat, identityPilotEnabled,
  pinImageGenKeyHost, imageGenKeyResolve,
  asrCredentialResolve, asrCredentialSlotOf, asrCredentialSlot, asrEndpointHost,
  ASR_PROVIDERS
} from '../../core/config.js';
import { ttsServiceById, ttsServiceOfBaseUrl, ttsServiceOf } from '../../llm/tts-presets.js';
import { initPriceFeed } from '../../pricing/price-feed.js';
import { initChannelPrices } from '../../pricing/channel-prices.js';
import { sanitizeConfigSecrets } from '../../core/secret-keys.js';

export function registerConfigRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const updateConfig = deps.updateConfig;
  const auditWrite = deps.auditWrite;
  const emit = deps.emit;
  const log = deps.log;
  const store = deps.store;
  const orchestrator = deps.orchestrator;
  const sessions = deps.sessions;
  const mcpManager = deps.mcpManager;
  const pluginRegistry = deps.pluginRegistry;
  const dailyMoments = deps.dailyMoments;
  const lifeFeed = deps.lifeFeed;
  const qzoneInteractions = deps.qzoneInteractions;
  const groupDigest = deps.groupDigest;
  const adminBriefing = deps.adminBriefing;
  const safeConfigWithAsrStatus = deps.safeConfigWithAsrStatus;
  const syncIncidentPilot = deps.syncIncidentPilot;
  const syncIdentityPilot = deps.syncIdentityPilot;
  const syncSlangPilot = deps.syncSlangPilot;
  const getConfigConflict = deps.getConfigConflict;
  const getBoundServerHost = deps.getBoundServerHost;
  const dataDir = deps.dataDir;
  const configLog = deps.configLog;
  const mcpLog = deps.mcpLog;
  const stableJson = deps.stableJson;
  if (!router || !json || !readBody || !getConfig || !updateConfig || !auditWrite || !emit || !log
    || !store || !orchestrator || !sessions || !mcpManager || !pluginRegistry || !dailyMoments
    || !lifeFeed || !qzoneInteractions || !groupDigest || !adminBriefing || !safeConfigWithAsrStatus
    || !syncIncidentPilot || !syncIdentityPilot || !syncSlangPilot
    || !getConfigConflict || !getBoundServerHost || !dataDir || !configLog || !mcpLog || !stableJson) {
    throw new Error('registerConfigRoutes 依赖不完整');
  }

  /** 顶层键差异清单（config.update 的审计摘要用）；只比 JSON 形态，键名排序稳定。 */
  const changedTopKeys = (a, b) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).sort();
  };

  router.add('GET', '/api/config', async (req, res) => {
    const cfgNow = getConfig();
    // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
    // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
    // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
    const safe = safeConfigWithAsrStatus(cfgNow);
    return json(res, 200, safe);
  });
  router.add('POST', '/api/config', async (req, res) => {
    const patch = await readBody(req);
    // readBody 可能很慢（设置页整包可达数 MB），期间别的保存/接口写入可能已经落盘。
    // 快照必须取在读完之后：下面 tts/imageGen/asr 的 keys、voices 都是"服务端维护的映射"，
    // 用旧快照重建会把并发请求刚写进去的 Key 静默抹掉。
    const cfgNow = getConfig();
    // 审计（#5）：getConfig() 返回引用，patch 应用后会被就地改写 —— 必须先拍快照，
    // 否则 before 会被写成 after（等于没记；方案附录 J.2）。与合并用同一份快照，
    // 避免把并发请求的改动算到本次请求头上。
    const auditBefore = structuredClone(cfgNow);
    // ── 整节替换（{ __replace__: X }）会把"映射由服务端维护"整条绕过：deepMerge 直接换成
    //    客户端对象，我们算好的 keys 被丢掉，客户端于是能把 keys 映射写进配置（2026-10-02
    //    全量审查实测：`{asr:{__replace__:{keys:{'openai|evil…':{apiKey:'ATK'}}}}}` 落盘成功）。
    //    这里把服务端算好的映射**钉回替换对象**：整节替换语义保留，但 keys 仍归服务端。
    const stampServerKeys = (section, nextKeys) => {
      const node = patch?.[section];
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const replaced = node.__replace__;
      if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) replaced.keys = nextKeys;
      node.keys = nextKeys;
    };
    // 整节替换下 deepMerge 只取替换体，节点层的删改/读取都落不到最终配置上 —— 凡是要"动这一节"
    // 的地方都取**有效体**：有对象替换体就用它，否则用节点本身。不这样，替换体里的归属钉会直接
    // 生效（delete 删不到）、`api.__replace__.baseUrl` 也让 pin 读不到新地址（2026-10-02 推前复审实测）。
    const sectionBody = (node) => (node && typeof node === 'object' && !Array.isArray(node)
      && node.__replace__ && typeof node.__replace__ === 'object' && !Array.isArray(node.__replace__)
      ? node.__replace__
      : node);
    // ── api 的两个"逃生口"文本域：提交内容与当前值的**脱敏形态**逐字相同时，当作没改 ──
    // extraBody / thinkingParams 在界面上是文本域，用脱敏视图回填、保存时原样 __replace__ 提交。
    // 脱敏会把对象形态的密钥字段换成 hasXxx（F6 的修复），于是"打开设置页什么都不改直接保存"
    // 就会把真配置覆盖成 {normal:'ok', hasAuthorization:true} —— 用户的自定义请求头没了，
    // 还多一个 hasAuthorization 进请求体（2026-10-04 复审 P2 实测）。
    // 判据与 Key 字段的掩码语义同款：脱敏视图原样回传 = "没动过"。
    // 用户真要删某个字段时提交内容与脱敏形态不同（少了那项），照样生效 —— 不影响"清空"。
    // ⚠️ 光有"逐字相同→没改"还不够（2026-10-04 复审 P2）：用户在**同一个框里改了别的字段**
    // 再保存，提交内容 ≠ 脱敏形态 → 守卫不删 → hasXxx 占位照样整键落盘 —— 真请求头被替换掉、
    // hasAuthorization 还会以最高优先级并进每一次模型请求。所以凡是提交里出现 hasXxx、
    // 而服务端现值里有对应的真键，就把真值**回填**回去（等价于"掩码 = 保持原值"的 Key 语义）。
    const unmaskSubmitted = (submitted, current) => {
      // 数组也要逐元素回填：`{headers:[{authorization:…}]}` 这种形态，脱敏后元素里只剩
      // `hasAuthorization`，不回填就会带着占位整段替换掉真值 —— 真 Key 静默丢失
      //（2026-10-05 复审实测：__replace__ 提交后盘上只剩 hasAuthorization）。
      // 按下标配对是启发式：用户重排数组元素时可能把旧值填到别的元素上（占位键本来就是
      // 脱敏产物，宁可保错也不能丢）。
      if (Array.isArray(submitted)) {
        const curArr = Array.isArray(current) ? current : [];
        return submitted.map((item, i) => unmaskSubmitted(item, curArr[i]));
      }
      if (!submitted || typeof submitted !== 'object') return submitted;
      const cur = (current && typeof current === 'object' && !Array.isArray(current)) ? current : {};
      const out = { ...submitted };
      for (const key of Object.keys(out)) {
        const value = out[key];
        if (/^has[A-Z]/.test(key)) {
          const realKey = key.charAt(3).toLowerCase() + key.slice(4);
          // 大小写不敏感地找服务端真实键名：extraBody 里常见 `Authorization` / `X-Api-Key`，
          // 脱敏生成 hasAuthorization，反推出来却是小写 authorization —— 直接 hasOwn 匹配不到，
          // 真值不回填、占位也不删，最后整段 __replace__ 落盘，真实请求头被静默丢掉。
          const lower = realKey.toLowerCase();
          const currentKey = Object.keys(cur).find((k) => k.toLowerCase() === lower) || '';
          const submittedHasReal = Object.keys(out).some((k) => k.toLowerCase() === lower);
          // ⚠️ 提交里同时带了真值（用户在这个框里填了新 Key）时**真值优先**：无条件回填
          // 服务端旧值会把刚填的新 Key 悄悄丢掉（2026-10-04 复审 P2）。
          // 回填到**服务端真实键名**：extraBody 里的 `Authorization` / `X-Api-Key`
          // 大小写有语义，按占位名反推会改成小写（2026-10-31 盲审 P2）。
          if (!submittedHasReal && currentKey) out[currentKey] = structuredClone(cur[currentKey]);
          if (currentKey) delete out[key];
          continue;
        }
        if (value && typeof value === 'object' && Object.hasOwn(cur, key)) {
          out[key] = unmaskSubmitted(value, cur[key]);
        }
      }
      return out;
    };
    if (patch?.api && typeof patch.api === 'object') {
      const apiGuard = sectionBody(patch.api);
      const sanitizedApi = sanitizeConfigSecrets({ api: cfgNow.api || {} }).api || {};
      for (const field of ['extraBody', 'thinkingParams']) {
        const raw = apiGuard[field];
        if (raw === undefined) continue;
        const isReplace = raw && typeof raw === 'object' && !Array.isArray(raw) && '__replace__' in raw;
        const submitted = isReplace ? raw.__replace__ : raw;
        if (stableJson(submitted) === stableJson(sanitizedApi[field])) {
          // 视图原样回传 = 用户没动这个框 → 整项当没改（快速路径）。
          // ⚠️ 两种形态都要 delete：非 __replace__ 时前端会在「JSON 解析失败/填了数组」
          // 的回退分支里原样回传脱敏视图（ui/pages/settings-save.js "已保留原值"），
          // 把它 clone 进 patch 就等于把视图里的 hasXxx 占位**落盘**，
          // 之后每次模型请求都被 Object.assign(body, extraBody) 带上
          //（2026-10-05 复审实测：盘上出现 hasAuthorization:true）。
          delete apiGuard[field];
          continue;
        }
        // 用户改了内容：把视图里的 hasXxx 占位换回服务端真值再落盘
        const healed = unmaskSubmitted(submitted, cfgNow.api?.[field]);
        if (isReplace) raw.__replace__ = healed;
        else apiGuard[field] = healed;
      }
    }
    // imageGen.extraBody 是同一个"文本域回填脱敏视图"的坑：Moss 的自定义参数也可能
    // 叫 authorization/token 之类，GET 时会被脱敏成 hasXxx。打开设置页原样保存一次
    // 不能把真值换成占位，否则每个生图请求都会带上 hasAuthorization。
    if (patch?.imageGen && typeof patch.imageGen === 'object') {
      const imgGuard = sectionBody(patch.imageGen);
      // 发送格式只认两个值；手改配置或旧前端传来的其它值一律回落默认（表情），
      // 免得以后新增枚举时旧值在运行期变成"既不是图片也不是表情"的第三种状态。
      if (imgGuard.sendAs !== undefined && imgGuard.sendAs !== 'image' && imgGuard.sendAs !== 'sticker') {
        imgGuard.sendAs = 'sticker';
      }
      const raw = imgGuard.extraBody;
      if (raw !== undefined) {
        const isReplace = raw && typeof raw === 'object' && !Array.isArray(raw) && '__replace__' in raw;
        const submitted = isReplace ? raw.__replace__ : raw;
        const sanitizedImageGen = sanitizeConfigSecrets({ imageGen: cfgNow.imageGen || {} }).imageGen || {};
        if (stableJson(submitted) === stableJson(sanitizedImageGen.extraBody)) {
          delete imgGuard.extraBody;
        } else {
          const healed = unmaskSubmitted(submitted, cfgNow.imageGen?.extraBody);
          if (isReplace) raw.__replace__ = healed;
          else imgGuard.extraBody = healed;
        }
      }
    }
    // 控制台保存总会带上显式的 provider（来自服务预设）：等于用户确认过这一家，
    // 清掉"升级默认值"的标记，让环境变量 Key 恢复生效（2026-09-26 审查 P2）。
    // 要删在**有效体**上：整节替换时节点层的 delete 落不到最终配置上，替换体里那份
    // providerDefaulted 会一路进 deepMerge 落盘，永久屏蔽 ASR_API_KEY 环境变量（2026-10-04 复审 P2）。
    if (patch?.asr && typeof patch.asr === 'object') delete sectionBody(patch.asr).providerDefaulted;
    // tts 的 Key 与 asr 同款语义：留空/掩码占位 = 保持原值（掩码回写会把真 Key 冲掉）
    if (patch?.tts && typeof patch.tts === 'object') {
      const ttsBody = sectionBody(patch.tts);
      // 服务端派生位（GET 时下发的布尔/归属口径）：不回写配置（2026-09-29 审查 P2，
      // 之前 keyServices/currentService 会随保存被持久化进 config.json）
      delete ttsBody.hasApiKey;
      delete ttsBody.keyServices;
      delete ttsBody.currentService;
      // 归属钉同样由服务端算：客户端直接送 apiKeyService 就能把别家的旧 Key 改绑到当前这家，
      // 而 ttsKeyFor 会照新归属把它发出去（与 asr/imageGen 同一条防线，这里原先漏了）
      delete ttsBody.apiKeyService;
      delete ttsBody.hasApiKeyService;
      // 前端只送"这一家新填的 Key"（apiKeyInput）与当前服务：合并进 keys 映射，
      // 绝不接受整份 keys 覆盖（那会把别家的 Key 冲掉）。空/掩码 = 保持不变。
      const keyInput = String(ttsBody.apiKeyInput ?? '').trim();
      delete ttsBody.apiKeyInput;
      delete ttsBody.keys;
      // voices 映射由服务端维护：客户端只送当前 voice，不能整份覆盖别家的记忆。
      delete ttsBody.voices;
      // Key 归属 = UI 选中那家（service），地址反查只作兜底。之前只按地址认：
      // 「自定义/自建」的地址不在预设表里 → 落到 provider 字符串 'openai'，
      // 运行时又读不到 keys['openai']（2026-09-29 审查 P0）
      const uiService = ttsServiceById(String(ttsBody.service || '').trim())?.id || '';
      delete ttsBody.service;
      // 显式送了 baseUrl（哪怕是空串）就按本次的算：切到「自定义」时前端会清空地址，
      // 用 `ttsBody.baseUrl || 旧地址` 会把这一单错误归到上一家（voice/Key 都会存错）。
      const baseForLookup = Object.hasOwn(ttsBody, 'baseUrl')
        ? String(ttsBody.baseUrl || '').trim()
        : String(cfgNow.tts?.baseUrl || '').trim();
      const svc = ttsServiceOfBaseUrl(baseForLookup);
      // UI 选中的预设优先于地址反查：自定义网关可能填了和某家预设相同的地址。
      const targetId = uiService || svc?.id || String(ttsBody.provider || cfgNow.tts?.provider || 'openai');
      // 每家上次用的音色：客户端切预设时只送当前这一家的 voice，服务端按 targetId 记住；
      // 切回来时 UI 从 voices[这家] 恢复，不会把上一家的音色（如 MiMo 的 Chloe）发给豆包。
      const nextTtsVoices = { ...(cfgNow.tts?.voices || {}) };
      const submittedVoice = String(ttsBody.voice ?? '').trim();
      if (submittedVoice) nextTtsVoices[targetId] = submittedVoice;
      ttsBody.voices = nextTtsVoices;
      const nextTtsKeys = keyInput && keyInput !== '******'
        ? { ...(cfgNow.tts?.keys || {}), [targetId]: keyInput }
        : { ...(cfgNow.tts?.keys || {}) };
      ttsBody.keys = nextTtsKeys;
      stampServerKeys('tts', nextTtsKeys);
      // 老客户端/手写配置不带 provider：按地址反查预设，免得火山/MiniMax 的地址走了 openai 兼容实现
      if (!ttsBody.provider && ttsBody.baseUrl) {
        const svc = ttsServiceOfBaseUrl(ttsBody.baseUrl);
        if (svc?.provider) ttsBody.provider = svc.provider;
      }
      const submittedKey = String(ttsBody.apiKey ?? '').trim();
      if (!submittedKey || submittedKey === '******') delete ttsBody.apiKey;
      // ── 单槽 Key 的归属（2026-10-03）── 必须放在上面那句之后：它把 apiKeyInput 清掉、
      //    再判"这次有没有真提交"；而"空/掩码 = 保持原值"那句会把我下面置的空串 delete 掉。
      //
      // ── 归档必须**无条件先跑**（与 imageGen/asr 同一口径，2026-10-04 复审 P1）──
      // 存量实例的 Key 只存在于 tts.apiKey 这一个字段里（keys 映射是控制台从 2026-09-29 起
      // 才写的）。之前归档写在"没填新 Key"那个分支里，于是"切服务 **并** 填一把新 Key"
      // 这条最常见的路径完全绕过了归档：那把旧 Key 留在单槽里、归属钉却被改成新服务 ——
      // 等用户再切回原服务且没填 Key 时，归属比较判成"别家的"，而 keys[原归属] 已被新 Key
      // 占位 → 不归档 → 直接置空 → **旧 Key 永久丢失**，控制台再也找不回来。
      const prevTtsKey = String(cfgNow.tts?.apiKey || '').trim();
      // 归属比较必须用"改动前"的配置：改完之后 current 已经变成新服务，拿它比会判成"就是这家的"。
      const ownerNow = String(cfgNow.tts?.apiKeyService || '').trim() || ttsServiceOf(cfgNow.tts)?.id || '';
      if (prevTtsKey && ownerNow && ownerNow !== targetId && !String(nextTtsKeys[ownerNow] || '').trim()) {
        nextTtsKeys[ownerNow] = prevTtsKey;
        ttsBody.keys = nextTtsKeys;
        stampServerKeys('tts', nextTtsKeys);
      }
      if (keyInput && keyInput !== '******') {
        // 新填的这把归属就是这一家（切回它时兜底才认）。单槽**同步换成新 Key**：
        // 只改钉不换槽的话，单槽里留的是上一家的 Key，归属钉却指着这一家 —— 与 asr/imageGen
        // 写入时"单槽装新值 + 钉指新归属"的口径反着来（2026-10-04 复审 P1）。
        ttsBody.apiKey = keyInput;
        ttsBody.apiKeyService = targetId;
      } else if (prevTtsKey && ownerNow !== targetId) {
        // 切到**没存过 Key** 的服务且没填 → 不沿用上一家的单槽 Key（与 asr/imageGen 同一口径）。
        // ⚠️ 置空串才是"清空"：delete 只是"这次不提交"（空/掩码 = 保持原值）。
        ttsBody.apiKey = '';
        ttsBody.apiKeyService = '';
      }
    }
    // imageGen 的 Key：与 tts 同款语义（留空/掩码 = 保持原值）。前端已按此过滤，
    // 这里再兜一层 —— 配置是外部可编辑的，别让一次手写的空串把 Key 冲掉。
    // （派生结论 available/hasApiKey 的剥离在 migrateConfig：那是所有写入路径的必经口，
    //   也顺带兜住读盘 —— 与 asr 同款，见 IMAGEGEN_DERIVED_KEYS 的说明）
    if (patch?.imageGen && typeof patch.imageGen === 'object') {
      const imgBody = sectionBody(patch.imageGen);
      // 服务端派生的布尔/归属口径：不回写配置
      delete imgBody.keyStale;
      delete imgBody.keyHosts;
      // keys 映射由服务端维护：客户端只送"这一家新填的 Key"（apiKey），绝不接受整份覆盖
      // （那会把别家存过的 Key 冲掉 —— 与 tts.keys 同款口径，2026-10-02）。
      // apiKeyHost 同款：归属钉一律由服务端按"本次提交的地址/凭据"重算 —— 客户端直接送它
      // 就能把旧 Key 的归属改到别的主机，等于绕过归属守卫（2026-10-02 全量审查实测）。
      delete imgBody.keys;
      delete imgBody.apiKeyHost;
      // 目标主机：按本次提交的地址算（没有就用当前地址；留空 = 跟聊天模型同家）。
      // ⚠️ 模型地址要用**本次 patch 之后**的值：同一次 POST 里既改 api.baseUrl 又填图 Key 时，
      // 用改动前的地址会把 Key 钉到旧主机（运行期按新地址找不到它；换回旧主机时又把它发给旧主机）。
      // 2026-10-02 全量审查实测的"保存期归属与运行期不一致"；`api.__replace__.baseUrl` 同样算数。
      const apiBody = sectionBody(patch.api);
      const nextApiBase = apiBody && apiBody.baseUrl !== undefined ? apiBody.baseUrl : cfgNow.api?.baseUrl;
      const keyTargetHost = pinImageGenKeyHost(
        { baseUrl: imgBody.baseUrl ?? cfgNow.imageGen?.baseUrl ?? '' },
        nextApiBase
      );
      const nextKeys = { ...(cfgNow.imageGen?.keys || {}) };
      // 归档：当前活动槽那把先记到它自己的主机名下 —— 老配置只有单槽（升级上来的实例），
      // 不归档就会在"切到别家并新填一把"时被覆盖丢掉，切回来再也取不回。
      const prevKey = String(cfgNow.imageGen?.apiKey || '').trim();
      const prevHost = String(cfgNow.imageGen?.apiKeyHost || '').trim().toLowerCase();
      if (prevKey && prevKey !== '******' && prevHost && !String(nextKeys[prevHost] || '').trim()) {
        nextKeys[prevHost] = prevKey;
      }
      const submittedKey = String(imgBody.apiKey ?? '').trim();
      if (submittedKey && submittedKey !== '******') {
        // 新填的 Key：记为当前活动 Key（归属钉照旧）＋ 存进"这家存过的"映射，切回来能自动取回
        if (keyTargetHost) nextKeys[keyTargetHost] = submittedKey;
        imgBody.keys = nextKeys;
        pinImageGenKeyHost(imgBody, nextApiBase);
      } else {
        // 留空/掩码 = "用这家存过的"（2026-10-02 用户要求）：切到哪家就取哪家存过的那把 ——
        // 存过就取回（连归属一起）；没存过就**不动现有的那把**：它由归属钉挡住使用
        // （不会发给别家），留着切回去还能用，界面按 keyHosts 显示"这家还没存过"。
        delete imgBody.apiKey;
        const resolved = imageGenKeyResolve(
          {
            ...(cfgNow.imageGen || {}),
            keys: nextKeys,
            ...(imgBody.baseUrl !== undefined ? { baseUrl: imgBody.baseUrl } : {})
          },
          keyTargetHost
        );
        if (resolved.value) {
          imgBody.apiKey = resolved.value;
          // 明确属于这个主机的才写回归属钉/补映射；"没记归属"的老单槽只用值、不认领
          if (resolved.owned) {
            nextKeys[keyTargetHost] = resolved.value;
            imgBody.keys = nextKeys;
            imgBody.apiKeyHost = keyTargetHost;
          }
        }
      }
      stampServerKeys('imageGen', nextKeys);
    }
    // ASR 的凭据：与 tts/imageGen 同款语义（2026-10-02 用户要求："切换服务预设时 Key 跟着切换"）。
    // 三种凭据（apiKey / secretId / secretKey，后者两家与讯飞百度共用字段）各按"槽位"记忆，
    // 槽位口径见 asrCredentialSlot：OpenAI 兼容按地址主机分家，其余按 provider。
    if (patch?.asr && typeof patch.asr === 'object') {
      const asrBody = sectionBody(patch.asr);
      delete asrBody.keySlots;                // 服务端派生的视图口径：不回写配置
      delete asrBody.keys;                    // 映射由服务端维护，绝不接受整份覆盖
      const curAsr = cfgNow.asr || {};
      // ⚠️ provider 必须在**写盘前**校验：它直接决定槽位名（asrCredentialSlot）。
      // 客户端送 `provider:"constructor"` 时槽位名就成了 "constructor"，而落盘的
      // keys['constructor'] 之后会让 asrKeySlots 取到 Object.prototype.constructor 并抛错，
      // **每一次读 /api/config 都 500**，且没有任何 API 能删掉那个槽位（2026-10-04 复审 P2 实测）。
      // ASR_PROVIDERS 之外的取值一律当"没改这一项"，沿用当前配置（坏输入最该被忽略）。
      const submittedProvider = String(asrBody.provider ?? '').trim().toLowerCase();
      const currentProvider = String(curAsr.provider || 'openai').trim().toLowerCase();
      const nextProvider = (submittedProvider && ASR_PROVIDERS.includes(submittedProvider))
        ? submittedProvider
        : currentProvider;
      if (asrBody.provider !== undefined && submittedProvider !== nextProvider) {
        delete asrBody.provider;   // 非法值/空串都别带进 deepMerge（空 = "这次没改这一项"）
      }
      const nextBaseUrl = asrBody.baseUrl !== undefined ? asrBody.baseUrl : (curAsr.baseUrl || '');
      const targetSlot = asrCredentialSlot(nextProvider, nextBaseUrl);
      const nextKeys = { ...(curAsr.keys || {}) };
      // 槽位条目必须是对象：手改成标量（"keys":{"tencent":"SCALAR"}）时 `{...'SCALAR'}` 会摊成
      // 字符索引的垃圾键写进配置（2026-10-02 推前复审）。migrateConfig 只归一化顶层映射，这里兜条目。
      // 目标槽与归档槽共用这一个守卫：只给目标槽加的话，归档路径仍会把标量摊成 {0:'S',1:'C',…}
      // 写进 config.json（同一段代码两套标准 = 漏改，2026-10-04 复审 P1）。
      const entryOf = (value) => (value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value } : {});
      const prevEntry = nextKeys[targetSlot];
      const slotEntry = entryOf(prevEntry);
      const credentials = [
        ['apiKey', 'apiKeyProvider', 'apiKeyHost'],
        ['secretId', 'secretIdProvider', ''],
        ['secretKey', 'secretKeyProvider', '']
      ];
      // 归属钉同款：一律由服务端按"本次提交的 provider/地址/凭据"重算 —— 客户端直接送它，
      // 就能把别家的旧凭据改绑到当前这家（或反过来），绕过归属守卫（2026-10-02 全量审查实测）。
      for (const [, providerField, hostField] of credentials) {
        delete asrBody[providerField];
        if (hostField) delete asrBody[hostField];
      }
      // 归档：活动槽里"这家还没有副本"的凭据先记到它自己的槽名下 —— 老配置只有单槽，
      // 切到别家新填凭据时会覆盖它，不归档就丢了（切回来取不回）。
      for (const [kind, providerField, hostField] of credentials) {
        const value = String(curAsr[kind] || '').trim();
        if (!value || value === '******') continue;
        // 只归档**归属明确**的那把（pin 非空）：归属未知的老凭据没有"自己的家"可记，而且用
        // 当前 provider 去猜会在同一次保存里被"取回"分支当成这家的凭据认领（推前复审实测：
        // 讯飞/百度的 secretKey 会被写回归属钉并塞进目标槽）
        const owner = String(curAsr[providerField] || '').trim().toLowerCase();
        if (!owner) continue;
        const host = hostField
          ? (String(curAsr[hostField] || '').trim().toLowerCase() || asrEndpointHost(curAsr.baseUrl))
          : '';
        const slot = asrCredentialSlotOf(owner, host);
        const entry = entryOf(nextKeys[slot]);
        if (!String(entry[kind] || '').trim()) entry[kind] = value;
        nextKeys[slot] = entry;
      }
      for (const [kind, providerField, hostField] of credentials) {
        const submitted = String(asrBody[kind] ?? '').trim();
        if (submitted && submitted !== '******') {
          // 新填的凭据：写进"这家存过的"映射 + 更新归属钉（切回来能自动取回）
          if (targetSlot) slotEntry[kind] = submitted;
          asrBody[providerField] = nextProvider;
          if (hostField) asrBody[hostField] = nextProvider === 'openai' ? asrEndpointHost(nextBaseUrl) : '';
          continue;
        }
        // 留空/掩码 = "用这家存过的"：取到就填回；**明确属于这家的**才写回归属钉/补映射 ——
        // "归属未知"的老凭据只用值、不认领（认领会把别家的凭据洗成这家的，2026-10-02 全量审查；
        // migrateConfig 的注释警告的正是这条路）。没取到就不动现有的：那把给别家存的，
        // 归属钉挡着不会被使用（切回去还能用）。
        delete asrBody[kind];
        const resolved = asrCredentialResolve(
          { ...curAsr, keys: nextKeys, baseUrl: nextBaseUrl },
          kind,
          nextProvider,
          nextBaseUrl
        );
        if (!resolved.value) continue;
        asrBody[kind] = resolved.value;
        if (!resolved.owned) continue;
        slotEntry[kind] = resolved.value;                // 取回的同时把映射补全（只补明确属于这家的）
        asrBody[providerField] = nextProvider;
        if (hostField) asrBody[hostField] = nextProvider === 'openai' ? asrEndpointHost(nextBaseUrl) : '';
      }
      if (targetSlot && Object.keys(slotEntry).length) nextKeys[targetSlot] = slotEntry;
      asrBody.keys = nextKeys;
      stampServerKeys('asr', nextKeys);
    }
    // 人设真的改了就打一个时间戳：提示词据此在接下来 24 小时里提醒模型
    // "历史里的旧口癖/自称不作数"（换卡后它会被自己的旧发言锚住，实测能锚一天以上）
    if (patch?.persona && typeof patch.persona === 'object') {
      const before = cfgNow.persona || {};
      const personaBody = sectionBody(patch.persona);
      // 时间戳只由服务端写：客户端送来的 changedAt 一律丢弃（否则可以伪造/永久压住"刚换过人设"的提醒）。
      // `__replace__` 形态必须删替换体里的字段；只删外层节点的话，替换体里的 changedAt 会照样生效。
      delete patch.persona.changedAt;
      delete personaBody.changedAt;
      const changed = ['roleText', 'templateId', 'behaviorProfile', 'customRules', 'botName',
        'selfNickname', 'participation']
        .some((key) => String(personaBody[key] ?? before[key] ?? '') !== String(before[key] ?? ''));
      if (changed) personaBody.changedAt = Date.now();
    }
    // 按群人设同理：哪个群的卡/正文变了，就给那个条目打时间戳（只影响该群，不误报全局）
    if (patch?.personaPerChat && typeof patch.personaPerChat === 'object') {
      const beforeMap = cfgNow.personaPerChat || {};
      const afterMap = patch.personaPerChat.__replace__ ?? patch.personaPerChat;
      if (afterMap && typeof afterMap === 'object' && !Array.isArray(afterMap)) {
        // 按键名排序后比较：保存时字段顺序会变（删了再赋值），用原生 JSON.stringify 会把
        // "没改"误判成"改了"，每保存一次都刷新 changedAt
        const stable = (value) => {
          const obj = { ...(value || {}) };
          delete obj.changedAt;
          return JSON.stringify(Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))));
        };
        for (const [key, entry] of Object.entries(afterMap)) {
          if (!entry || typeof entry !== 'object') continue;
          delete entry.changedAt;                 // 时间戳只由服务端写
          const old = beforeMap[key];
          if (stable(entry) !== stable(old)) entry.changedAt = Date.now();
          else if (old?.changedAt) entry.changedAt = old.changedAt;
        }
      }
    }
    const previousProactive = JSON.stringify(cfgNow.proactive || {});
    const previousDailyMoments = JSON.stringify(cfgNow.dailyMoments || {});
    const previousLifeFeed = JSON.stringify(cfgNow.lifeFeed || {});
    const previousQzoneInteractions = JSON.stringify(cfgNow.qzoneInteractions || {});
    const previousIdentityPilot = JSON.stringify(cfgNow.identityPilot || {});
    const previousPlugins = JSON.stringify(cfgNow.plugins || {});
    const previousPersona = JSON.stringify(cfgNow.persona || {});
    const previousSlangPilot = JSON.stringify(cfgNow.slangPilot || {});
    const previousIncidentPilot = JSON.stringify(cfgNow.incidentPilot || {});
    const previousIdentitySources = JSON.stringify({
      allow: cfgNow.allow || {},
      deny: cfgNow.deny || {},
      allowAllWhenEmpty: cfgNow.allowAllWhenEmpty === true,
      blocklist: cfgNow.blocklist || {}
    });
    const previousModes = new Map(
      store.listChats().map((chatKey) => [chatKey, conversationConfigForChat(chatKey).mode])
    );
    delete patch.runtime;
    if (patch.server) {
      // 整节替换（`__replace__`）时 delete 删的是节点层，替换体里的 token 会直接落盘 ——
      // 服务重启后 authorize 读不到令牌（控制台全部登出），下次 start() 还会因"绑非回环却无令牌"
      // 直接 throw 起不来（2026-10-03 全量审查）。归属与派生位一律取**有效体**处理。
      const serverBody = sectionBody(patch.server);
      // 2026-10-06 复审：替换体里的 token 必被剥（下面 delete，令牌只走专用端点）→ 整节替换后
      // server.token 必空，而运行中的套接字不随配置重绑 —— 绑 0.0.0.0 时这一保存会把监听降级为
      // "无令牌 + Host 头判本机"的免鉴权模式。运行期套接字仍在非回环地址上时，拒绝一切 server 整节替换。
      const serverReplacing = patch.server.__replace__ && typeof patch.server.__replace__ === 'object'
        && !Array.isArray(patch.server.__replace__);
      if (serverReplacing && getBoundServerHost() && !['127.0.0.1', 'localhost', '::1'].includes(getBoundServerHost())) {
        // 直接回 409 而不是 throw：统一异常处理器会把一切抛错记成 error 级 incident，
        // 而这是"管理员存了个会被拒的配置"的**预期内拒绝**，不该刷异常面板
        //（2026-10-06 生产实测踩到：一次守卫验证就在 journal 和异常面板各留了一条 error）。
        return json(res, 409, {
          ok: false,
          error: '控制台正绑定在非回环地址上运行，整节替换 server 段会清空令牌且套接字不会重新绑定；请改用普通保存，或先停机改配置'
        });
      }
      delete serverBody.token;
      delete serverBody.hasToken;
    }
    // webSearch：自定义搜索服务列表 providers 是**密钥数组**，而 deepMerge 对数组是整体替换 ——
    // 界面回传的是脱敏副本（apiKey 被删、hasApiKey 被加），直接提交会把每家的 Key 冲掉
    // （2026-10-03 全量审查）。这里按 id 与服务端对齐：客户端没带新值就沿用服务端那把。
    if (patch?.webSearch && typeof patch.webSearch === 'object') {
      const wsBody = sectionBody(patch.webSearch);
      if (Array.isArray(wsBody.providers)) {
        const stored = new Map((cfgNow.webSearch?.providers || [])
          .map((item) => [String(item?.id || ''), item]));
        wsBody.providers = wsBody.providers
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
          .map((item) => {
            const next = { ...item };
            delete next.hasApiKey;
            const submitted = String(next.apiKey ?? '').trim();
            if (!submitted || submitted === '******') {
              const prev = stored.get(String(next.id || ''));
              if (prev && String(prev.apiKey || '').trim()) next.apiKey = prev.apiKey;
              else delete next.apiKey;
            }
            return next;
          });
      }
      // 派生位（sanitize 生成的 hasApiKey）由 migrateConfig 统一剔 —— 它是所有写入路径的必经口，
      // 路由层再剥一遍是冗余（同一语义写两处，反而会让人以为两边口径不同）。
    }
    // MCP env/args：界面拿到的是 ****** 掩码，提交时按 server id + key/下标恢复服务端原值；
    // 用户把某个 key 删掉/填空则按新值落盘，不会被旧值偷偷补回来。
    if (patch?.mcp && typeof patch.mcp === 'object') {
      const mcpBody = sectionBody(patch.mcp);
      if (Array.isArray(mcpBody.servers)) {
        const stored = new Map((cfgNow.mcp?.servers || []).map((server) => [String(server?.id || ''), server]));
        mcpBody.servers = mcpBody.servers.map((server) => {
          const prev = stored.get(String(server?.id || ''));
          if (!prev) return server;
          const env = { ...(server.env || {}) };
          for (const [key, value] of Object.entries(env)) {
            if (String(value) === '******' && prev.env?.[key]) env[key] = prev.env[key];
          }
          const args = Array.isArray(server.args)
            ? server.args.map((arg, index) => (arg === '******' && prev.args?.[index] ? prev.args[index] : arg))
            : server.args;
          return { ...server, env, args };
        });
      }
    }
    let next;
    const force = new URL(req.url, 'http://127.0.0.1').searchParams.get('force') === '1';
    try {
      next = updateConfig(patch, { force });
    } catch (error) {
      auditWrite('config.update', 'config', { req, before: auditBefore, ok: false, error: String(error?.message ?? error) });
      if (error?.code === 'CONFIG_CONFLICT') {
        return json(res, 409, {
          ok: false,
          code: 'CONFIG_CONFLICT',
          error: String(error.message || '配置文件已被外部修改'),
          configConflict: error.configConflict || getConfigConflict()
        });
      }
      // updateConfig 的校验错误自带 httpStatus=400（见 config-legacy 的 invalidConfig）；
      // 文件系统/内部错误没有这个标记，按 500 处理并进异常面板。
      throw error;
    }
    auditWrite('config.update', 'config', { req, before: auditBefore, after: next, changed: changedTopKeys(auditBefore, next) });
    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
    store.setSynchronous(next.store?.sqliteSynchronous);
    sessions.setPersistIntervalMs(next.store?.sessionPersistMs);
    sessions.setStoragePolicy({
      compressAfterDays: next.store?.sessionCompressAfterDays,
      maxTotalMb: next.store?.sessionMaxTotalMb
    });
    if (patch?.mcp) {
      try { await mcpManager.reload(); }
      catch (error) { mcpLog('配置保存后重载失败:', error); }
    }
    let closedThreads = 0;
    for (const [chatKey, previousMode] of previousModes) {
      if (conversationConfigForChat(chatKey).mode !== previousMode) {
        if (store.closeConversationThread(chatKey, 'mode-changed')) closedThreads += 1;
      }
    }
    if (closedThreads) emit('chat-update', '*');
    if (JSON.stringify(next.proactive || {}) !== previousProactive) {
      if (next.proactive?.enabled) orchestrator.startProactiveLoop();
      else orchestrator.stopProactiveLoop();
    }
    if (JSON.stringify(next.dailyMoments || {}) !== previousDailyMoments) {
      dailyMoments.reconfigure();
    }
    if (JSON.stringify(next.lifeFeed || {}) !== previousLifeFeed) {
      lifeFeed.reconfigure();
    }
    if (JSON.stringify(next.qzoneInteractions || {}) !== previousQzoneInteractions) {
      qzoneInteractions.reconfigure();
    }
    if (JSON.stringify(next.groupDigest || {}) !== JSON.stringify(cfgNow.groupDigest || {})) {
      groupDigest.reconfigure();
    }
    if (JSON.stringify(next.adminBriefing || {}) !== JSON.stringify(cfgNow.adminBriefing || {})
      || String(next.admin?.ownerUin || '') !== String(cfgNow.admin?.ownerUin || '')) {
      // 管理员 QQ 后补上时也要重新排程（否则要等进程重启才会有定时器）
      adminBriefing.reconfigure();
    }
    // 插件配置动了（总开关 / enabledIds / 插件自己的 settings）→ 重排：停掉再按新配置起。
    // 不 await：控制台保存不该等插件起进程（宿主内部自己 try/catch 并记日志）。
    if (JSON.stringify(next.plugins || {}) !== previousPlugins) {
      Promise.resolve(pluginRegistry.reconfigure())
        .catch((error) => log('[plugins] 重排失败：', error?.message ?? error));
    }
    if (JSON.stringify(next.incidentPilot || {}) !== previousIncidentPilot) {
      try {
        syncIncidentPilot();
        for (const chatKey of store.listChats()) orchestrator.enforceChatControl(chatKey);
      } catch (error) {
        const reverted = updateConfig({
          incidentPilot: { ...(next.incidentPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `异常处理实验启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    const identityChanged = JSON.stringify(next.identityPilot || {}) !== previousIdentityPilot;
    const identitySourcesChanged = JSON.stringify({
      allow: next.allow || {},
      deny: next.deny || {},
      allowAllWhenEmpty: next.allowAllWhenEmpty === true,
      blocklist: next.blocklist || {}
    }) !== previousIdentitySources;
    const personaChanged = JSON.stringify(next.persona || {}) !== previousPersona;
    if (
      identityChanged
      || (identityPilotEnabled(next) && (identitySourcesChanged || personaChanged))
    ) {
      try {
        await syncIdentityPilot({
          reindex: identitySourcesChanged,
          reconfigure: identityChanged || identitySourcesChanged || personaChanged
        });
      } catch (error) {
        const reverted = updateConfig({
          identityPilot: { ...(next.identityPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `统一身份库启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    if (JSON.stringify(next.slangPilot || {}) !== previousSlangPilot) {
      try {
        await syncSlangPilot();
      } catch (error) {
        const reverted = updateConfig({
          slangPilot: { ...(next.slangPilot || {}), enabled: false }
        });
        return json(res, 500, {
          ok: false,
          error: `黑话语料库启动失败，开关已恢复为关闭：${String(error?.message ?? error)}`,
          config: safeConfigWithAsrStatus(reverted)
        });
      }
    }
    initPriceFeed(next.api?.priceRemoteUrl || '');   // 远程价格表 URL 可能改了（内部幂等）
    initChannelPrices(next.api?.channelPriceFeeds || []);   // 渠道价目表同理
    emit('status', { configUpdated: true });
    return json(res, 200, { ok: true, config: safeConfigWithAsrStatus(next), configConflict: getConfigConflict() });
  });

  // 配置冲突时用户选择“重新加载磁盘配置”：丢内存快照、重新读盘，并按与保存路径相同的
  // 口径重排所有缓存配置的子系统；单个子系统起不来只记警告，不把整次重载判失败。
  router.add('POST', '/api/config/reload', async (req, res) => {
    // 只读地看一眼磁盘版本做前置校验：不调用 loadConfig()，避免它更新基线后让后续保存
    // 把这份被拒绝的配置当成“自己的版本”静默覆盖。
    let diskToken = '';
    try {
      const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
      diskToken = String(disk?.server?.token || '');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return json(res, 409, {
          ok: false,
          code: 'CONFIG_RELOAD_REJECTED',
          error: `磁盘 config.json 解析失败，未重载：${String(error?.message ?? error)}`
        });
      }
    }
    // 运行期套接字固定在 start() 的绑定地址上；重载一份没令牌的配置会让远程控制台立即失联。
    if (getBoundServerHost() && !['127.0.0.1', 'localhost', '::1'].includes(getBoundServerHost()) && !diskToken) {
      return json(res, 409, {
        ok: false,
        code: 'CONFIG_RELOAD_REJECTED',
        error: '磁盘配置没有控制台令牌，而控制台已绑定在非回环地址；重新加载会让远程控制台全部失联，请先恢复 server.token 再重载'
      });
    }

    const previous = getConfig();
    const previousModes = new Map(
      store.listChats().map((chatKey) => [chatKey, conversationConfigForChat(chatKey).mode])
    );
    const next = reloadConfig();
    const warnings = [];
    const warn = (label, error) => {
      const text = `${label}：${String(error?.message ?? error)}`;
      warnings.push(text);
      if (error instanceof Error) configLog(text, error);
      else configLog(text);
    };

    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
    store.setSynchronous(next.store?.sqliteSynchronous);
    sessions.setPersistIntervalMs(next.store?.sessionPersistMs);
    sessions.setStoragePolicy({
      compressAfterDays: next.store?.sessionCompressAfterDays,
      maxTotalMb: next.store?.sessionMaxTotalMb
    });

    let closedThreads = 0;
    for (const [chatKey, previousMode] of previousModes) {
      if (conversationConfigForChat(chatKey).mode !== previousMode) {
        if (store.closeConversationThread(chatKey, 'mode-changed')) closedThreads += 1;
      }
    }
    if (closedThreads) emit('chat-update', '*');

    if (JSON.stringify(next.proactive || {}) !== JSON.stringify(previous.proactive || {})) {
      if (next.proactive?.enabled) orchestrator.startProactiveLoop();
      else orchestrator.stopProactiveLoop();
    }
    if (JSON.stringify(next.dailyMoments || {}) !== JSON.stringify(previous.dailyMoments || {})) {
      dailyMoments.reconfigure();
    }
    if (JSON.stringify(next.lifeFeed || {}) !== JSON.stringify(previous.lifeFeed || {})) {
      lifeFeed.reconfigure();
    }
    if (JSON.stringify(next.qzoneInteractions || {}) !== JSON.stringify(previous.qzoneInteractions || {})) {
      qzoneInteractions.reconfigure();
    }
    if (JSON.stringify(next.groupDigest || {}) !== JSON.stringify(previous.groupDigest || {})) {
      groupDigest.reconfigure();
    }
    if (JSON.stringify(next.adminBriefing || {}) !== JSON.stringify(previous.adminBriefing || {})
      || String(next.admin?.ownerUin || '') !== String(previous.admin?.ownerUin || '')) {
      adminBriefing.reconfigure();
    }
    if (JSON.stringify(next.plugins || {}) !== JSON.stringify(previous.plugins || {})) {
      // 与保存路径一致：不 await，控制台重载不该等第三方插件子进程起完。
      Promise.resolve(pluginRegistry.reconfigure())
        .catch((error) => warn('插件重排失败', error));
    }
    if (JSON.stringify(next.mcp || {}) !== JSON.stringify(previous.mcp || {})) {
      try { await mcpManager.reload(); }
      catch (error) { warn('MCP 重载失败', error); }
    }

    if (JSON.stringify(next.incidentPilot || {}) !== JSON.stringify(previous.incidentPilot || {})) {
      try {
        syncIncidentPilot();
        for (const chatKey of store.listChats()) orchestrator.enforceChatControl(chatKey);
      } catch (error) {
        warn('异常处理实验重排失败', error);
      }
    }
    const identityChanged = JSON.stringify(next.identityPilot || {}) !== JSON.stringify(previous.identityPilot || {});
    const identitySourcesChanged = JSON.stringify({
      allow: next.allow || {},
      deny: next.deny || {},
      allowAllWhenEmpty: next.allowAllWhenEmpty === true,
      blocklist: next.blocklist || {}
    }) !== JSON.stringify({
      allow: previous.allow || {},
      deny: previous.deny || {},
      allowAllWhenEmpty: previous.allowAllWhenEmpty === true,
      blocklist: previous.blocklist || {}
    });
    const personaChanged = JSON.stringify(next.persona || {}) !== JSON.stringify(previous.persona || {});
    if (identityChanged || (identityPilotEnabled(next) && (identitySourcesChanged || personaChanged))) {
      try {
        await syncIdentityPilot({
          reindex: identitySourcesChanged,
          reconfigure: identityChanged || identitySourcesChanged || personaChanged
        });
      } catch (error) {
        warn('统一身份库重排失败', error);
      }
    }
    if (JSON.stringify(next.slangPilot || {}) !== JSON.stringify(previous.slangPilot || {})) {
      try { await syncSlangPilot(); }
      catch (error) { warn('黑话语料库重排失败', error); }
    }
    // 前面的 await（MCP/身份库/黑话库）可能持续数秒；期间另一个保存可能改了价目 URL。
    // 副作用一律用"现在"的配置，不能拿 reload 刚开始时的旧快照把运行态改回去。
    const latest = getConfig();
    initPriceFeed(latest.api?.priceRemoteUrl || '');
    initChannelPrices(latest.api?.channelPriceFeeds || []);

    auditWrite('config.reload', 'config', { req, changed: changedTopKeys(previous, next) });
    emit('status', { configUpdated: true });
    return json(res, 200, {
      ok: true,
      config: safeConfigWithAsrStatus(next),
      configConflict: getConfigConflict(),
      ...(warnings.length ? { warnings } : {})
    });
  });

}
