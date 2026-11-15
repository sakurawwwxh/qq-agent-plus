// 模型图片输入能力的扫描入口。后端 /api/vision/scan 早已存在，但此前控制台只能看
// 结果、没有触发按钮；这里补上当前服务商的按需扫描，避免把探测成本带进每次页面加载。
import { api } from '../core/api.js';
import { askForConfirmation } from '../core/dom-util.js';
import { $ } from '../core/dom.js';
import { state } from '../core/state.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setResult(text) {
  const el = $('#vision-scan-result');
  if (el) el.textContent = text;
}

function paintModelVerdict(providerId) {
  const model = String(state.config?.api?.model || '');
  const verdict = (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
  const hint = $('#model-vision-hint');
  if (hint) {
    hint.textContent = verdict === 'vision' ? '✅ 当前模型支持图片输入'
      : verdict === 'no-vision' ? '🚫 当前模型不支持图片输入' : '';
  }
  const switchHint = $('#vision-switch-hint');
  if (switchHint) switchHint.textContent = verdict === 'no-vision' ? '此模型不支持图片输入' : '';
}

async function runVisionScan(button) {
  const providerId = String(state.config?.api?.provider || '').trim();
  if (!providerId) {
    setResult('当前是手动地址模式：请先在模型 API 里选择服务商，再扫描图片能力。');
    return;
  }
  if (!await askForConfirmation(`会向「${providerId}」发送最多 3 次图片探测请求，可能产生少量费用。确定扫描？`)) return;
  const idle = button.textContent;
  button.disabled = true;
  button.textContent = '扫描中…';
  setResult('正在扫描…');
  try {
    await api('/api/vision/scan', {
      method: 'POST',
      body: JSON.stringify({ providerIds: [providerId] })
    });
    for (let i = 0; i < 80; i += 1) {
      await wait(1500);
      const data = await api('/api/vision/results');
      state.visionResults = data.results || {};
      state.visionScanning = data.scanning === true;
      if (!state.visionScanning) break;
    }
    paintModelVerdict(providerId);
    setResult(state.visionScanning ? '扫描仍在后台进行，稍后刷新结果。' : '扫描完成。');
  } catch (error) {
    setResult(`扫描失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = idle;
  }
}

document.addEventListener('click', (event) => {
  const button = event.target?.closest?.('#vision-scan-btn');
  if (!button || button.disabled) return;
  event.preventDefault();
  void runVisionScan(button);
});
