// 识图专用模型（visionModel）：配置解析 + 降纔回退契约。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { visionModelConfig, describeImagesViaVisionModel } = await import('../src/tools/tools-core.js');

test('visionModelConfig：未配置 → null（走原行为）', () => {
  assert.equal(visionModelConfig({ api: { baseUrl: 'https://x', apiKey: 'k' } }), null);
});

test('visionModelConfig：配了模型 → 三元组', () => {
  const vis = visionModelConfig({ api: { baseUrl: 'https://x/', apiKey: 'k', visionModel: 'glm-5-3-flash' } });
  assert.deepEqual(vis, { baseUrl: 'https://x/', apiKey: 'k', model: 'glm-5-3-flash' });
});

test('visionModelConfig：缺 baseUrl / 缺 key → null（调用方回退直塞图，不阻塞）', () => {
  assert.equal(visionModelConfig({ api: { apiKey: 'k', visionModel: 'm' } }), null);
  assert.equal(visionModelConfig({ api: { baseUrl: 'https://x', visionModel: 'm' } }), null);
});

// 回退是行为契约：识图调用抛错（网络/模型挂）→ 错误向上抛，由工具 execute 的 catch
// 回退到"图片 parts 直塞聊天模型"（旧行为），消息链路不中断。这里验证抛错路径本身。
test('describeImagesViaVisionModel：请求失败时抛错（调用方 catch 回退直塞图）', async () => {
  // 指向不存在的端点，chatCompletion 会抛"模型请求失败"
  await assert.rejects(
    () => describeImagesViaVisionModel(
      { baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'nope', timeoutMs: 2000 },
      '背景', ['data:image/png;base64,iVBORw0KGgo=']
    )
  );
});

// 成功路径契约：返回 { text, usage }——usage 供调用方 addUsage 记账（复审意见 2）。
// 直连真实端点不可测，这里只验返回结构约定由源码保证（返回字面量），不 mock chatCompletion。
