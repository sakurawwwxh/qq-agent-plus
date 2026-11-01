// 素材观测（表情 / 黑话 / 人物 / 群记忆）路由
// （从 console/app.js 拆出，2026-10-31 结构整治 M2）。
// 自然顺序即注册顺序：overview → stickers（列表/新增/分析/图片）→ slang → identities
// → memory，再是四条 PUT/DELETE 正则路由。别把 `/api/assets/stickers` 的字面量路由
// 挪到 `/api/assets/stickers/:id` 之后，虽然这里 method 不同不冲突，但快照顺序是契约。
import crypto from 'node:crypto';
import { safeFetchBinary } from '../../llm/safe-fetch.js';
import { imageType } from '../../core/image-type.js';
import { chatCompletion } from '../../llm/llm.js';

function decodeImageDataUrl(value) {
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i
    .exec(String(value || ''));
  if (!match) throw new Error('图片数据格式无效');
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('表情图片不能超过 8 MiB');
  return buffer;
}

export function registerAssetRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const emit = deps.emit;
  const assetObserver = deps.assetObserver;
  const stickers = deps.stickers;
  const slangPilotStatus = deps.slangPilotStatus;
  const identityPilotStatus = deps.identityPilotStatus;
  const refreshIdentityAfterAssetMutation = deps.refreshIdentityAfterAssetMutation;
  if (!router || !json || !readBody || !emit || !assetObserver || !stickers
    || !slangPilotStatus || !identityPilotStatus || !refreshIdentityAfterAssetMutation) {
    throw new Error('registerAssetRoutes 需要 router/json/readBody/emit/assetObserver/stickers/各状态函数');
  }

  router.add('GET', '/api/assets/overview', async (req, res) => {
    const overview = assetObserver.overview();
    const pilotStatus = slangPilotStatus();
    return json(res, 200, {
      ...overview,
      slang: { ...overview.slang, active: pilotStatus.active },
      slangPilot: pilotStatus
    });
  });
  router.add('GET', '/api/assets/stickers', async (req, res, params, url) => {
    const result = await assetObserver.listStickers({
      query: url.searchParams.get('query') || '',
      offset: url.searchParams.get('offset') || 0,
      limit: url.searchParams.get('limit') || 100,
      refresh: url.searchParams.get('refresh') === '1'
    });
    // QQ 收藏表情有上限（非会员 500）：满了之后新收藏只能进本地图库（发出去是图片），
    // 界面据此解释清楚，别让人以为"表情包坏了"
    try { result.qqFavorites = await stickers.qqFavoritesState(); } catch { /* 拿不到就不显示 */ }
    return json(res, 200, result);
  });
  router.add('POST', '/api/assets/stickers', async (req, res) => {
    try {
      const body = await readBody(req, 12 * 1024 * 1024);
      let imageBuffer;
      if (body.imageDataUrl) {
        imageBuffer = decodeImageDataUrl(body.imageDataUrl);
      } else if (body.imageUrl) {
        imageBuffer = (await safeFetchBinary(
          String(body.imageUrl),
          8 * 1024 * 1024
        )).buffer;
      } else {
        return json(res, 400, { error: '请选择图片文件或填写图片 URL' });
      }
      const entry = assetObserver.addSticker({
        imageBuffer,
        desc: body.desc,
        localNote: body.localNote,
        tags: body.tags,
        usage: body.usage
      });
      emit('asset-update', { kind: 'stickers', action: 'create', id: entry.id });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('POST', '/api/assets/stickers/analyze', async (req, res) => {
    try {
      const body = await readBody(req, 12 * 1024 * 1024);
      let imageBuffer;
      let mime;
      if (body.stickerId) {
        const id = String(body.stickerId).trim();
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) return json(res, 400, { error: '表情 ID 无效' });
        const localImage = stickers.readImage(id);
        if (localImage) { imageBuffer = localImage.buffer; mime = localImage.contentType; }
        else {
          const sticker = await stickers.findForSend(id);
          if (!sticker?.url) return json(res, 404, { error: '表情图片不存在' });
          imageBuffer = (await safeFetchBinary(sticker.url, 8 * 1024 * 1024)).buffer;
          mime = imageType(imageBuffer);
        }
      } else {
        imageBuffer = decodeImageDataUrl(body.imageDataUrl);
        mime = imageType(imageBuffer);
      }
      if (!mime) return json(res, 400, { error: '图片内容无效或格式不受支持' });
      const result = await chatCompletion({
        purpose: 'sticker-image-description',
        temperature: 0.2,
        maxTokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '你是表情包管理助手。观察图片，生成适合检索和聊天调用的中文元数据。严格只返回 JSON 对象，不要 Markdown：{"desc":"简短名称，最多20字","localNote":"客观描述画面主体、动作、文字和情绪，最多100字","tags":["2-6个简短标签"],"usage":"适合使用的聊天语境，最多60字"}。只描述图中可见内容，不推断人物身份或背景。' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBuffer.toString('base64')}` } }
          ]
        }]
      });
      const text = String(result.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const metadata = JSON.parse(text);
      return json(res, 200, {
        ok: true,
        metadata: {
          desc: String(metadata.desc || '').slice(0, 80),
          localNote: String(metadata.localNote || '').slice(0, 300),
          tags: Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag).slice(0, 40)).slice(0, 20) : [],
          usage: String(metadata.usage || '').slice(0, 300)
        }
      });
    } catch (error) {
      return json(res, error?.httpStatus || 502, { error: `图片分析失败：${String(error?.message ?? error).slice(0, 240)}` });
    }
  });
  router.add('GET', '/api/assets/stickers/image', async (req, res, params, url) => {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return json(res, 400, { error: '缺少表情 ID' });
    let sticker = stickers.peek(id);
    const localImage = stickers.readImage(id);
    if (localImage) {
      // 贴纸图片按 id 内容恒定（id 唯一、删除后不再出现）：长缓存 + 强 ETag。
      // 2026-10-02：观测页每张 126KB，36 张约 4.5MB，重复浏览不该重下。
      const etag = `"s-${id}"`;
      if (String(req.headers['if-none-match'] || '') === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, max-age=604800, immutable' });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': localImage.contentType,
        'content-length': localImage.buffer.length,
        'cache-control': 'private, max-age=604800, immutable',
        etag,
        'x-content-type-options': 'nosniff'
      });
      res.end(localImage.buffer);
      return;
    }
    if (sticker?.source === 'ai') {
      // 收藏表情的远程链接过期时 findForSend 会抛 STICKER_LINK_DEAD。控制台预览一张已失效的
      // 收藏图不是系统错误，不能记进异常面板（会在错误页留一条红项）；返回 404 让界面显示坏图。
      try {
        sticker = await stickers.findForSend(id);
      } catch (error) {
        if (error?.code === 'STICKER_LINK_DEAD') return json(res, 404, { error: '表情图片已失效' });
        throw error;
      }
    }
    if (!sticker?.url) return json(res, 404, { error: '表情图片不存在' });
    // 远程表情图片（QQ 表情 URL 里带 md5、内容恒定）：ETag + 一天浏览器缓存。
    // 2026-10-02 实测：线上 42 张贴纸**全部**只有远程 URL、没有本地文件，观测页每张
    // 缩略图都要服务器现去 QQ 拉一次且只缓存 60 秒 —— 每次进页面把整套图重拉一遍。
    const remoteEtag = `"u-${crypto.createHash('sha1').update(String(sticker.url)).digest('hex').slice(0, 16)}"`;
    if (String(req.headers['if-none-match'] || '') === remoteEtag) {
      res.writeHead(304, { etag: remoteEtag, 'cache-control': 'private, max-age=86400' });
      res.end();
      return;
    }
    try {
      const image = await safeFetchBinary(sticker.url, 8 * 1024 * 1024);
      const contentType = String(image.contentType || '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        return json(res, 502, { error: '表情资源不是图片' });
      }
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': image.buffer.length,
        'cache-control': 'private, max-age=86400',
        etag: remoteEtag,
        'x-content-type-options': 'nosniff'
      });
      res.end(image.buffer);
      return;
    } catch (error) {
      return json(res, 502, { error: `表情图片读取失败：${String(error?.message ?? error)}` });
    }
  });
  router.add('GET', '/api/assets/slang', async (req, res, params, url) => {
    return json(res, 200, assetObserver.listSlang({
      query: url.searchParams.get('query') || '',
      status: url.searchParams.get('status') || '',
      offset: url.searchParams.get('offset') || 0,
      limit: url.searchParams.get('limit') || 200
    }));
  });
  router.add('POST', '/api/assets/slang', async (req, res) => {
    try {
      const entry = assetObserver.addSlang(await readBody(req));
      emit('asset-update', { kind: 'slang', action: 'create', id: entry.id });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/assets/identities', async (req, res, params, url) => {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 500));
    return json(res, 200, assetObserver.identitySnapshot({
      limit,
      query: url.searchParams.get('query') || ''
    }));
  });
  router.add('POST', '/api/assets/identities', async (req, res) => {
    try {
      const person = assetObserver.upsertIdentity(await readBody(req));
      emit('asset-update', { kind: 'identities', action: 'create', id: person.userId });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 201, { ok: true, person });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('GET', '/api/assets/memory', async (req, res, params, url) => {
    // limit：这个接口要遍历"每个会话 × 每个成员"，不带上限时多群实例会一次吐出上千行
    // （前端还要把它们全渲染成表格）。默认 500，与身份列表同一口径（2026-10-08 审查）。
    return json(res, 200, assetObserver.memorySummary({
      query: url.searchParams.get('query') || '',
      limit: Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500))
    }));
  });
  router.add('POST', '/api/assets/memory', async (req, res) => {
    try {
      const entry = assetObserver.addMemory(await readBody(req));
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(entry.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'create' });
      return json(res, 201, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', '/api/assets/memory', async (req, res) => {
    try {
      const body = await readBody(req);
      const member = assetObserver.updateMemory(body);
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(body.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'update' });
      return json(res, 200, { ok: true, member });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', '/api/assets/memory', async (req, res) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除记忆需要显式确认' });
      if (!assetObserver.deleteMemory(body)) return json(res, 404, { error: '记忆不存在' });
      await refreshIdentityAfterAssetMutation();
      emit('memory-update', { chatKey: String(body.chatKey || '') });
      emit('asset-update', { kind: 'memory', action: 'delete' });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });

  router.add('PUT', /^\/api\/assets\/stickers\/([^/]+)$/, async (req, res, params) => {
    try {
      const id = decodeURIComponent(params[1]);
      const body = await readBody(req);
      const entry = assetObserver.updateSticker(id, {
        desc: body.desc,
        localNote: body.localNote,
        tags: body.tags,
        usage: body.usage
      });
      if (!entry) return json(res, 404, { error: '表情不存在' });
      emit('asset-update', { kind: 'stickers', action: 'update', id });
      return json(res, 200, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/stickers\/([^/]+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除表情需要显式确认' });
      const id = decodeURIComponent(params[1]);
      const result = assetObserver.deleteSticker(id);
      if (!result?.removed) return json(res, 404, { error: '表情不存在' });
      emit('asset-update', { kind: 'stickers', action: 'delete', id });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', /^\/api\/assets\/slang\/([^/]+)$/, async (req, res, params) => {
    try {
      const id = decodeURIComponent(params[1]);
      const entry = assetObserver.updateSlang(id, await readBody(req));
      if (!entry) return json(res, 404, { error: '黑话词条不存在' });
      emit('asset-update', { kind: 'slang', action: 'update', id });
      return json(res, 200, { ok: true, entry });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/slang\/([^/]+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除黑话需要显式确认' });
      const id = decodeURIComponent(params[1]);
      if (!assetObserver.deleteSlang(id)) return json(res, 404, { error: '黑话词条不存在' });
      emit('asset-update', { kind: 'slang', action: 'delete', id });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('PUT', /^\/api\/assets\/identities\/(\d+)$/, async (req, res, params) => {
    try {
      const person = assetObserver.upsertIdentity({
        ...(await readBody(req)),
        userId: params[1]
      });
      emit('asset-update', { kind: 'identities', action: 'update', id: person.userId });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 200, { ok: true, person });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
  router.add('DELETE', /^\/api\/assets\/identities\/(\d+)$/, async (req, res, params) => {
    try {
      const body = await readBody(req);
      if (body.confirm !== true) return json(res, 409, { error: '删除人物需要显式确认' });
      if (!assetObserver.deleteIdentity(params[1])) {
        return json(res, 404, { error: '人物不存在' });
      }
      emit('asset-update', { kind: 'identities', action: 'delete', id: params[1] });
      emit('identity-pilot-update', identityPilotStatus());
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, error?.httpStatus || 400, { error: String(error?.message ?? error) });
    }
  });
}
