(() => {
  'use strict';

  const CONSOLE_MARKER = 'qq-agent-console';
  let enhancing = false;
  let scheduled = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_MARKER,
        ...(options.headers || {})
      },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  function validBranch(branch) {
    return /^[A-Za-z0-9._/-]{1,100}$/.test(branch)
      && !branch.startsWith('-')
      && !branch.includes('..')
      && !branch.endsWith('/');
  }

  function connectivityText(status) {
    const c = status?.connectivity || {};
    if (c.status === 'testing' || c.status === 'queued') return 'GitHub 连通性：测试中…';
    // 通道：git = 直连 GitHub 的 git 协议；api = git 不通时改走 GitHub API + codeload 源码包
    const lane = c.transport === 'api' ? '（API/源码包通道）' : (c.transport === 'git' ? '（git 通道）' : '');
    if (c.status === 'ok') {
      const revision = c.revision ? ` · ${String(c.revision).slice(0, 12)}` : '';
      return `GitHub 连通性：正常${lane} · ${Number(c.attempts) || 1} 次尝试 · ${Number(c.latencyMs) || 0} ms${revision}`;
    }
    if (c.status === 'failed') return `GitHub 连通性：失败 · ${c.error || '未知错误'}`;
    return 'GitHub 连通性：尚未测试';
  }

  function fieldValue(id, fallback = '') {
    return document.getElementById(id)?.value ?? fallback;
  }

  function checked(id, fallback = false) {
    const element = document.getElementById(id);
    return element ? element.checked : fallback;
  }

  function advancedPayload() {
    const branch = String(fieldValue('auto-update-branch-advanced', 'main')).trim();
    if (!validBranch(branch)) throw new Error('部署分支名称无效');
    const retries = Math.min(10, Math.max(0, Math.round(Number(fieldValue('auto-update-retries', 4)) || 0)));
    const baseSeconds = Math.min(30, Math.max(0.1, Number(fieldValue('auto-update-retry-base', 1.5)) || 1.5));
    const maxSeconds = Math.min(120, Math.max(baseSeconds, Number(fieldValue('auto-update-retry-max', 15)) || 15));
    return {
      branch,
      networkRetries: retries,
      retryBaseMs: Math.round(baseSeconds * 1000),
      retryMaxMs: Math.round(maxSeconds * 1000),
      connectivityTimeoutSeconds: Math.min(120, Math.max(3, Math.round(Number(fieldValue('auto-update-connect-timeout', 20)) || 20))),
      fetchTimeoutSeconds: Math.min(1800, Math.max(30, Math.round(Number(fieldValue('auto-update-fetch-timeout', 300)) || 300))),
      forceHttp11: checked('auto-update-http11', true),
      disableOnFailure: checked('auto-update-disable-failure', true)
    };
  }

  async function saveAdvanced({ quiet = false } = {}) {
    const result = document.getElementById('auto-update-network-result');
    if (!quiet && result) {
      result.textContent = '正在保存网络策略…';
      result.className = 'control-result muted';
    }
    const payload = advancedPayload();
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ autoUpdate: payload })
    });
    if (!quiet && result) {
      result.textContent = '网络与失败策略已保存。';
      result.className = 'control-result success';
    }
    return payload;
  }

  async function pollProbe(result) {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const status = await api('/api/auto-update/status');
      if (result) {
        result.textContent = connectivityText(status);
        result.className = `control-result ${status.connectivity?.status === 'failed' ? 'error' : 'muted'}`;
      }
      if (
        status.mode === 'probe'
        && status.busy !== true
        && ['ok', 'failed'].includes(status.connectivity?.status)
      ) {
        result.className = `control-result ${status.connectivity.status === 'ok' ? 'success' : 'error'}`;
        return status;
      }
    }
    throw new Error('连通性测试等待超时，请稍后刷新状态');
  }

  async function runConnectivityProbe() {
    const button = document.getElementById('auto-update-connectivity-test');
    const result = document.getElementById('auto-update-network-result');
    if (button) button.disabled = true;
    if (result) {
      result.textContent = '正在启动服务端 GitHub 连通性测试…';
      result.className = 'control-result muted';
    }
    try {
      await saveAdvanced({ quiet: true });
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ autoUpdate: { nextAction: 'probe' } })
      });
      await api('/api/auto-update/run', {
        method: 'POST',
        body: JSON.stringify({ confirm: true })
      });
      await pollProbe(result);
    } catch (error) {
      if (result) {
        result.textContent = `连通性测试失败：${error.message}`;
        result.className = 'control-result error';
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  function advancedMarkup(status) {
    const c = status.connectivity || {};
    const retryBase = (Number(status.retryBaseMs) || 1500) / 1000;
    const retryMax = (Number(status.retryMaxMs) || 15000) / 1000;
    const connectivityClass = c.status === 'failed' ? 'error' : c.status === 'ok' ? 'success' : 'muted';
    return `
      <div data-auto-update-network class="update-deploy-settings" style="margin-top:10px;align-items:end">
        <label><span>部署分支</span>
          <input type="text" id="auto-update-branch-advanced" list="auto-update-branch-options" value="${esc(status.branch || 'main')}" autocomplete="off" />
          <datalist id="auto-update-branch-options"><option value="main"></option><option value="${esc(status.branch || 'main')}"></option></datalist>
        </label>
        <label><span>Git 网络重试次数</span><input type="number" id="auto-update-retries" min="0" max="10" value="${esc(status.networkRetries ?? 4)}" /></label>
        <label><span>首次重试等待（秒）</span><input type="number" id="auto-update-retry-base" min="0.1" max="30" step="0.1" value="${esc(retryBase)}" /></label>
        <label><span>最大重试等待（秒）</span><input type="number" id="auto-update-retry-max" min="0.5" max="120" step="0.5" value="${esc(retryMax)}" /></label>
        <label><span>连通测试超时（秒）</span><input type="number" id="auto-update-connect-timeout" min="3" max="120" value="${esc(status.connectivityTimeoutSeconds ?? 20)}" /></label>
        <label><span>Git 拉取超时（秒）</span><input type="number" id="auto-update-fetch-timeout" min="30" max="1800" value="${esc(status.fetchTimeoutSeconds ?? 300)}" /></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="auto-update-http11" ${status.forceHttp11 !== false ? 'checked' : ''} /><span>强制 Git HTTP/1.1</span></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="auto-update-disable-failure" ${status.disableOnFailure !== false ? 'checked' : ''} /><span>失败后禁用自动更新</span></label>
        <div class="settings-actions" style="grid-column:1 / -1">
          <button type="button" class="btn btn-small" id="auto-update-network-save" ${status.busy ? 'disabled' : ''}>保存网络策略</button>
          <button type="button" class="btn btn-small" id="auto-update-connectivity-test" ${!status.installed || status.busy ? 'disabled' : ''}>测试 GitHub 连通性</button>
        </div>
      </div>
      <div id="auto-update-network-result" class="control-result ${connectivityClass}" data-auto-update-connectivity style="margin-top:8px" role="status" aria-live="polite">${esc(connectivityText(status))}</div>
      <div class="muted" data-auto-update-network-note style="margin-top:4px">GitHub 预检使用目标仓库 + 目标分支；开启 HTTP/1.1 可规避部分 GnuTLS / HTTP2 链路抖动。npm 安装优先使用本地缓存并继承相同重试参数。</div>`;
  }

  async function enhance() {
    if (enhancing) return;
    const root = document.getElementById('control-page');
    const basic = root?.querySelector('.update-deploy-settings');
    if (!root || !basic || root.querySelector('[data-auto-update-network]')) return;
    enhancing = true;
    try {
      const status = await api('/api/auto-update/status');
      if (!document.contains(basic) || root.querySelector('[data-auto-update-network]')) return;
      const holder = document.createElement('div');
      holder.innerHTML = advancedMarkup(status);
      const fragment = document.createDocumentFragment();
      while (holder.firstChild) fragment.appendChild(holder.firstChild);
      basic.insertAdjacentElement('afterend', document.createElement('div'));
      const spacer = basic.nextElementSibling;
      spacer.replaceWith(fragment);
      document.getElementById('auto-update-network-save')?.addEventListener('click', () => {
        saveAdvanced().catch((error) => {
          const result = document.getElementById('auto-update-network-result');
          if (result) {
            result.textContent = `保存失败：${error.message}`;
            result.className = 'control-result error';
          }
        });
      });
      document.getElementById('auto-update-connectivity-test')?.addEventListener('click', runConnectivityProbe);
    } catch {
      // 主控制页仍可正常使用；增强配置在下一次 DOM 更新时重试。
    } finally {
      enhancing = false;
    }
  }

  function scheduleEnhance() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      enhance();
    }, 0);
  }

  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleEnhance();
})();
