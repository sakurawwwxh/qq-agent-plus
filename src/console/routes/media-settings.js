// 语音（TTS）与图片生成（ImageGen）设置/试听/试画路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M3）。
// 明文 Key 端点沿用 keyEndpointAllowed：只允许本机控制台或带令牌的请求。
import { synthesizeSpeech } from '../../llm/tts.js';
import { generateImage, imageGenEffectiveHost, resolveImageGenAuth } from '../../llm/image-gen.js';
import { TTS_SERVICES, ttsServiceOfBaseUrl, ttsKeyFor } from '../../llm/tts-presets.js';
import { IMAGEGEN_SERVICES } from '../../llm/image-gen-presets.js';
import { imageGenAvailable, imageGenKeyOwnedBy } from '../../core/config.js';
import { fetchModelsFrom } from '../../core/providers.js';
import { resolveApiKey } from '../../llm/llm.js';
import { imageType } from '../../core/image-type.js';

export function registerMediaSettingsRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getConfig = deps.getConfig;
  const keyEndpointAllowed = deps.keyEndpointAllowed;
  if (!router || !json || !readBody || !getConfig || !keyEndpointAllowed) {
    throw new Error('registerMediaSettingsRoutes 需要 router/json/readBody/getConfig/keyEndpointAllowed');
  }

  router.add('GET', '/api/tts/key', async (req, res) => {
    const cfgNow = getConfig();
    // 显示当前这家的明文 Key（与模型 API 的「显示密钥」同一道守卫：本机控制台或带令牌）
    if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '只能在控制台里查看密钥' });
    const svcId = String(new URL(req.url, 'http://127.0.0.1').searchParams.get('service') || '');
    const key = ttsKeyFor(cfgNow.tts, svcId);
    return json(res, 200, { ok: true, apiKey: key });
  });
  router.add('POST', '/api/tts/models', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const provider = String(body.provider || cfgNow.tts?.provider || 'openai').trim().toLowerCase();
      if (provider !== 'openai') {
        // 火山（v1/v3）与 MiniMax 没有"列模型"的公开接口：模型名/音色按服务商文档内置。
        // 这里如实说明该填什么，而不是回空列表让界面显示"共 0 个"（2026-09-28 用户实测反馈）。
        const svc = ttsServiceOfBaseUrl(body.baseUrl || cfgNow.tts?.baseUrl || '')
          || TTS_SERVICES.find((s) => s.provider === provider);
        return json(res, 200, {
          ok: true,
          models: [],
          ttsOnly: false,
          unsupported: true,
          total: 0,
          note: svc?.note || '这一家没有可拉的模型列表：按服务商文档填模型名与音色。'
        });
      }
      const baseUrl = String(body.baseUrl || cfgNow.tts?.baseUrl || '').trim();
      const submitted = String(body.apiKey ?? '').trim();
      const norm = (v) => String(v || '').trim().replace(/[/]+$/, '').toLowerCase();
      const apiKey = (submitted && submitted !== '******')
        ? submitted
        : (norm(baseUrl) === norm(cfgNow.tts?.baseUrl) ? ttsKeyFor(cfgNow.tts) : '');
      const all = await fetchModelsFrom(baseUrl, apiKey);
      const isTtsModel = (id) => {
        const name = String(id);
        if (/whisper|sensevoice|asr|recognition|stt|transcri/i.test(name)) return false;   // ASR 不是 TTS
        return /tts|text.?to.?speech|speech.?synth|cosyvoice|moss|voice/i.test(name);
      };
      const models = all.filter(isTtsModel).sort((a, b) => a.localeCompare(b));
      return json(res, 200, {
        ok: true,
        models: models.length ? models : [...all].sort((a, b) => a.localeCompare(b)),
        ttsOnly: models.length > 0,
        total: all.length
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/tts/test', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const text = String(body.text ?? '').trim().slice(0, 120) || '你好呀，我是群里的小鲸鱼，这是一条试听。';
      if (cfgNow.tts?.enabled !== true) return json(res, 400, { ok: false, error: '语音回复未启用（勾上并保存后再试听）' });
      const { buffer, format } = await synthesizeSpeech({ cfg: cfgNow.tts, text });
      return json(res, 200, { ok: true, format, audio: buffer.toString('base64') });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

  // 显示「图片生成」当前生效的明文 Key（与 TTS/模型 API 同一道守卫：本机控制台或带令牌）。
  // 2026-09-30 审查：界面上有「显示」按钮却没有这条路由，点了没反应、已存的 Key 读不回来。
  router.add('GET', '/api/imagegen/presets', async (req, res) => json(res, 200, { ok: true, services: IMAGEGEN_SERVICES }));

  router.add('GET', '/api/imagegen/key', async (req, res, params, url) => {
    if (!keyEndpointAllowed(req)) return json(res, 403, { ok: false, error: '只能在控制台里查看密钥' });
    const cfgNow = getConfig();
    // 同 /api/asr-key：表单里换到**别的主机**（还没保存）时，回显那个主机存过的那把；
    // 按已保存配置解析会把当前那家的明文显示在新选的主机名下（2026-10-02 全量审查）。
    const askedHost = String(url.searchParams.get('host') || '').trim().toLowerCase();
    const effHost = imageGenEffectiveHost(cfgNow.imageGen, cfgNow.api);
    if (askedHost && askedHost !== effHost) {
      return json(res, 200, { ok: true, apiKey: imageGenKeyOwnedBy(cfgNow.imageGen, askedHost), reused: false, error: '' });
    }
    const auth = resolveImageGenAuth({
      imageGen: cfgNow.imageGen,
      api: cfgNow.api,
      apiKey: resolveApiKey(cfgNow)
    });
    // 「同域复用」时 auth.key 回的是**聊天模型那把 Key**：不能填进「图片生成」的输入框 ——
    // 保存只挡 '******'，一旦回显，用户点一次「保存设置」就把模型 Key 固化成 imageGen
    // 自有的 Key，"只发给同域"这条守卫从此对它失效（2026-10-01 审查 P2）。
    // 复用本来就是"留空即生效"，不需要明文；真要读模型 Key 去「模型 API」那边读。
    return json(res, 200, {
      ok: true,
      apiKey: auth.reused ? '' : (auth.key || ''),
      reused: auth.reused === true,
      error: auth.error || ''
    });
  });

  router.add('POST', '/api/imagegen/test', async (req, res) => {
    const cfgNow = getConfig();
    try {
      const body = await readBody(req);
      const prompt = String(body.prompt ?? '').trim().slice(0, 200) || '一只橘猫戴着草帽坐在海边，卡通风格';
      if (cfgNow.imageGen?.enabled !== true) return json(res, 400, { ok: false, error: '图片生成未启用（勾上并保存后再试）' });
      if (!imageGenAvailable(cfgNow)) return json(res, 400, { ok: false, error: '还没配好：至少要填模型；地址留空表示与聊天模型同域' });
      // 试画不落库、不占闸门（它是"验证配置对不对"，不是真用）；计费由服务商算，所以提示里写明。
      const { buffer } = await generateImage({
        cfg: cfgNow,
        apiCfg: cfgNow.api,
        apiKey: resolveApiKey(cfgNow),
        prompt
      });
      // 按实际字节写 MIME：各家回的不一样（智谱 CogView 回 JPEG），写死 png 的话
      // 右键「图片另存为」会存成"扩展名 .png 的 JPEG"。
      const mime = imageType(buffer) || 'image/png';
      return json(res, 200, {
        ok: true,
        bytes: buffer.length,
        mime,
        image: `data:${mime};base64,${buffer.toString('base64')}`
      });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error?.message ?? error) });
    }
  });

}
