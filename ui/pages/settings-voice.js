// 由 ui/app.js 机械拆出（2026-10-01，改进方案 §11「UI 结构治理」第二轮：设置域）。
// 设置页·语音回复分区（ASR/TTS 的渲染与绑定）
// 跨文件引用一律走 import（模块作用域，不往全局词法环境里放东西）；可变状态挂 state，见 AGENTS.md。
// 搬运只切不改：每个声明的源码与拆分前逐字节一致（脚本内已核对，勿手改缩进）。
'use strict';


import { api } from '../core/api.js';
import { ASR_SERVICES } from '../core/constants.js';
import { esc } from '../core/dom.js';
import { extraBodyText } from '../core/dom-util.js';
import { asrServiceOf, asrServiceOptions, normalizeAsrMax } from '../core/format.js';
import { state } from '../core/state.js';
/**
 * 语音转文字（ASR）独立分区：Key 与服务属于"外部服务配置"，跟聊天行为（聊天设置）分开放，
 * 与「搜索服务」相邻 —— 两者都是外部服务 + Key 那一类。
 * 供应商可换：识别服务与「搜索服务」不必是同一家，也不必是同一个账号。
 */
function renderAsrSection(c) {
  // 不再硬编码「已知 provider」清单：加了新服务却忘了改这里，会把新服务当成"本机"
  // （2026-09-26 就踩过：十家预设里四家渲染成了 custom）。未知值一律按"API Key 那一支"显示。
  const provider = String(c.asr?.provider || '').trim().toLowerCase() || 'local';
  // 容器里没有 git/cmake 等编译工具，不能在这里装本机 whisper.cpp。
  const containerMode = c?.runtime?.container === true;
  // 用户要求：只给两个选项 —— 免费的本机 Whisper，或"用 API Key 的托管服务"（具体哪家由下面的服务预设决定）
  const mode = provider === 'local' ? 'local' : 'api';
  const hide = (want) => (mode === want ? '' : 'display:none');
  // "已填"要用服务端算的可用性：凭据与"存它时的服务（OpenAI 兼容的还看地址主机）"绑定，
  // 换了家/换了地址就不算数 —— 这时输入框必须显示为空并给出可照做的提示，
  // 而不是显示 ****** 让人以为"这家已经能用了"（2026-09-26 审查，跨服务串用已实测）。
  const keyStored = c.asr?.hasApiKey === true;
  const keyUsable = c.asr?.keyUsable === true;
  const keyReady = keyStored && keyUsable;
  const openaiReady = String(c.asr?.baseUrl || '').trim() !== '' && String(c.asr?.model || '').trim() !== '';
  const localReady = Boolean(String(c.asr?.localModel || '').trim());
  const ready = typeof c.asr?.available === 'boolean'
    ? c.asr.available
    : (c.asr?.enabled !== false
      && (typeof c.asr?.configured === 'boolean'
        ? c.asr.configured
        : (mode === 'local' ? localReady : (provider === 'openai' ? (keyReady && openaiReady) : keyReady))));
  // 删除按钮只在"托管目录里真有东西"时显示
  const localInstalled = typeof c.asr?.localInstalled === 'boolean'
    ? c.asr.localInstalled
    : (Boolean(c.asr?.localBinResolved) && Boolean(c.asr?.localModelResolved));
  const localRemovable = typeof c.asr?.localManagedExists === 'boolean'
    ? c.asr.localManagedExists
    : localInstalled;
  const service = ASR_SERVICES.find((item) => item.id === asrServiceOf(provider, c.asr?.baseUrl)) || ASR_SERVICES[ASR_SERVICES.length - 1];
  const serviceNote = service?.note || '';
  const needsBaseUrl = service?.needsBaseUrl === true;
  const wants = (kind) => ((service?.creds || []).includes(kind) ? '' : 'display:none');
  // 同理：SecretId / SecretKey 也是按服务绑定的（腾讯的 SecretKey 不能当讯飞的 APISecret 用）
  const hasSecretId = c.asr?.hasSecretId === true && c.asr?.secretIdUsable === true;
  const hasSecretKey = c.asr?.hasSecretKey === true && c.asr?.secretKeyUsable === true;
  const secretWrongService = (c.asr?.hasSecretId === true && c.asr?.secretIdUsable !== true)
    || (c.asr?.hasSecretKey === true && c.asr?.secretKeyUsable !== true);
  const secretKeyLabel = provider === 'baidu' ? 'Secret Key（百度老式鉴权才需要）'
    : (provider === 'iflytek' ? 'APISecret（讯飞）' : 'SecretKey（腾讯云）');
  // 凭据不属于这一家：可能是已保存的（服务端判定），也可能是刚在下拉里换了服务（草稿标记）
  const keyWrongService = keyStored && !keyUsable;
  const credentialStale = c.asr?.credentialStale === true || keyWrongService || secretWrongService;
  const status = (c.asr?.enabled === false && c.asr?.configured === true)
    ? '<strong>配置是齐的，但上面的开关关着，所以不生效</strong>：勾上即用。'
    : ready
    ? (c.asr?.keySource === 'env'
      ? '<strong>已配置好，这项在生效</strong>（Key 来自环境变量 <code>ASR_API_KEY</code>，此处留空即可）。'
      : '<strong>已配置好，这项在生效。</strong>')
    : (mode === 'local'
      ? '<strong>本机转写还没装好，这项暂不生效</strong>（不会产生任何调用与费用）：可以点「安装本机转写」装好它；更快也更省事的做法是改用 API Key 的托管服务（推荐，硅基流动有免费模型）。'
      : (credentialStale
        ? '<strong>换了识别服务或服务地址，请重新填一次凭据（Key / Secret），否则这项不会生效</strong>：'
          + '配置里的凭据与"存它时的服务（OpenAI 兼容的还看地址主机）"绑定，后端不会把它发到别家 —— '
          + '这是有意的，避免把 A 家的 Key 送到 B 家去。'
        : (provider === 'openai' && keyReady && !openaiReady
          ? '<strong>还缺服务地址或模型，这项不会生效</strong>：地址由服务预设填好，模型点「获取模型列表」从服务商官网拉。'
          : '<strong>还没有可用的 Key，这项不会生效</strong>：工具不会注入给模型，也不会产生任何调用与费用 —— 表现与没开这项时一样（提示词会照旧说"听不了语音"）。')));
  return `
    <h3 id="settings-asr">语音转文字</h3>
    <div class="hint" style="margin-bottom:10px">
      把消息里的语音、音频文件、视频音轨转成文字再交给聊天模型 —— 与模型是否多模态无关。
      <strong>推荐用 API Key 的托管服务</strong>：更快、不用在本机下模型，免费的也有（硅基流动、Groq）；
      只想完全不注册账号再用免费的本机 Whisper（要下载模型，转写慢一些）。
      识别服务与「搜索服务」各自独立，不必是同一家、也不必是同一个账号。
    </div>

    <div class="checkbox-row"><input type="checkbox" id="cfg-asr" ${c.asr?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-asr">启用语音转文字</label></div>

    <div class="field">
      <label for="cfg-asr-mode">用哪种方式</label>
      <select id="cfg-asr-mode">
        <option value="api" ${mode === 'api' ? 'selected' : ''}>API Key · 托管服务（推荐：更快，有免费额度）</option>
        <option value="local" ${mode === 'local' ? 'selected' : ''}>免费 · 本机安装的 Whisper（不联网、不要 Key，较慢）</option>
      </select>
    </div>

    <div id="asr-local-mode" style="${hide('local')}">
      <div class="hint">
        <strong>推荐优先考虑上面的 API Key 托管服务</strong>：不用下载 466MB、转写速度也快得多
        （硅基流动有免费模型，注册一下就能用）。下面是"零 Key、离线"的本地方案：
        点按钮在这台机器上装（自动构建 + 从国内镜像下模型，默认 small 约 466MB），装完自动生效；
        不想要了可以完整卸载，把那 500MB 收回来。
      </div>
      <div class="field-row">
        <div class="field"><label for="cfg-asr-bin">whisper.cpp 可执行文件</label>
          <input type="text" id="cfg-asr-bin" value="${esc(c.asr?.localBin || '')}" placeholder="留空自动找：安装脚本产物 → whisper-cli / whisper-cpp / main" /></div>
        <div class="field"><label for="cfg-asr-localmodel">模型文件路径</label>
          <input type="text" id="cfg-asr-localmodel" value="${esc(c.asr?.localModel || '')}" placeholder="留空自动找 &lt;数据目录&gt;/asr/ggml-*.bin" /></div>
      </div>
      <div class="hint" id="cfg-asr-local-resolved">
        当前会自动用：<code>${esc(c.asr?.localBinResolved || '（还没找到可执行文件）')}</code>
        ＋ <code>${esc(c.asr?.localModelResolved || '（还没找到模型文件）')}</code>
      </div>
      <div class="field" id="asr-install-field" style="${containerMode ? 'display:none' : ''}">
        <button class="btn btn-primary btn-small" id="asr-install-btn" type="button">${localInstalled ? '重新安装 / 修复' : '安装本机转写（免费）'}</button>
        ${localRemovable ? '<button class="btn btn-small btn-danger" id="asr-uninstall-btn" type="button">完全卸载（删除模型与程序）</button>' : ''}
        <span id="asr-install-hint" class="muted">${localInstalled
          ? '已装好，无需再装。'
          : '约 466MB（small 模型）+ 几分钟构建；装完自动生效，不用重启。'}</span>
        <div id="asr-install-progress" class="hint" style="display:none"></div>
      </div>
      <div class="hint" id="asr-container-hint" style="${containerMode ? '' : 'display:none'}">
        容器模式：镜像里没有编译工具，不能在这里安装本机转写。请改用上面的托管服务，或构建包含 whisper.cpp 的自定义镜像。
      </div>
    </div>

    <div id="asr-api-mode" style="${hide('api')}">
      <div class="field">
        <label for="cfg-asr-service">服务预设</label>
        <select id="cfg-asr-service">${asrServiceOptions(provider, c.asr?.baseUrl)}</select>
        <div class="hint">
          <strong>推荐用这一支</strong>。选一家会自动填好接口地址；<strong>模型一律点「获取模型列表」从服务商官网拉</strong>
          —— 预设里写死模型名会过时（比如硅基流动新上的免费模型，列表跟着官网走才看得到）。
          免费的推荐硅基流动（国内可直连）或 Groq（有免费额度）；火山走它自己的协议。
        </div>
      </div>
      <div class="field-row" id="asr-openai-fields" style="${needsBaseUrl ? 'align-items:start' : 'display:none'}">
        <div class="field"><label for="cfg-asr-baseurl">服务地址（到 /v1 那层）</label>
          <input type="text" id="cfg-asr-baseurl" value="${esc(c.asr?.baseUrl || '')}" placeholder="https://api.siliconflow.cn/v1" /></div>
        <div class="field"><label for="cfg-asr-model">模型</label>
          <div style="display:flex;gap:8px">
            <input type="text" id="cfg-asr-model" value="${esc(c.asr?.model || '')}" placeholder="点右侧按钮拉语音模型，或手填" style="flex:1" />
            <button class="btn btn-small" id="asr-fetch-models-btn" type="button">获取模型列表</button>
          </div>
          <select id="cfg-asr-model-pick" style="display:none;margin-top:6px"></select>
          <div class="hint" id="asr-models-hint" style="display:none"></div>
        </div>
      </div>
      <div class="hint" id="asr-service-note">${esc(serviceNote)}</div>
      <div class="field" id="asr-appid-field" style="${wants('appId')}">
        <label for="cfg-asr-appid">AppID（讯飞）</label>
        <input type="text" id="cfg-asr-appid" value="${esc(c.asr?.appId || '')}" placeholder="讯飞控制台里那个 AppID" />
      </div>
      <div class="field" id="asr-key-field" style="${wants('key')}">
        <label for="cfg-asr-key">API Key（掩码 = 用这家存过的；这家没存过就留空等填）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-asr-key" value="${esc(keyReady ? '******' : '')}" placeholder="留空 = 用这家存过的；都没有时回落到环境变量 ASR_API_KEY" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-asr-key-toggle" type="button">显示</button>
        </div>
      </div>
      <div class="field" id="asr-secretid-field" style="${wants('secretId')}">
        <label for="cfg-asr-secretid">SecretId（腾讯云）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-asr-secretid" value="${esc(hasSecretId ? '******' : '')}" placeholder="腾讯云访问密钥的 SecretId（留空 = 用这家存过的）" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-asr-secretid-toggle" type="button">显示</button>
        </div>
      </div>
      <div class="field" id="asr-secretkey-field" style="${wants('secretKey')}">
        <label for="cfg-asr-secretkey">${esc(secretKeyLabel)}</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-asr-secretkey" value="${esc(hasSecretKey ? '******' : '')}" placeholder="输入后保存；留空 = 用这家存过的" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-asr-secretkey-toggle" type="button">显示</button>
        </div>
      </div>
    </div>

    <div class="field-row" style="align-items:start">
      <div class="field"><label for="cfg-asr-max">每小时最多转写（次）</label>
        <input type="number" id="cfg-asr-max" min="1" max="200" value="${normalizeAsrMax(c.asr?.maxPerHour)}"
          placeholder="1-200，默认 12" />
        <div class="hint">自己填 1-200（超出会按这个范围收口）。按"转写一条消息"计：长音频会拆成多段请求，服务商的额度按段扣。</div></div>
      <div class="field"><label for="cfg-asr-max-perchat">每会话每小时最多转写（次）</label>
        <input type="number" id="cfg-asr-max-perchat" min="1" max="200" value="${esc(Number(c.asr?.maxPerHourPerChat) > 0 ? Number(c.asr.maxPerHourPerChat) : 4)}" />
        <div class="hint">防止单个群刷爆全局额度，默认 4；全局上限仍以上面那项为准。</div></div>
      <div class="field"><label for="cfg-asr-lang">识别语言（可选）</label>
        <input type="text" id="cfg-asr-lang" value="${esc(c.asr?.language || '')}" placeholder="zh / en；留空由服务自己判" /></div>
    </div>
    <div class="hint">
      ${status}
      每小时上限是按量计费服务的硬闸门（跨会话共享）；本地转写不花钱，但也受这个次数限制。
    </div>
    <h3 id="settings-tts">语音回复（TTS）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-tts-enabled" ${c.tts?.enabled === true ? 'checked' : ''} />
      <label for="cfg-tts-enabled">允许机器人发语音（send_voice 工具；默认关）</label></div>
    <div class="field"><label for="cfg-tts-service">服务预设</label>
      <select id="cfg-tts-service"><option value="">（加载中…）</option></select>
      <div class="hint" id="tts-preset-hint"></div></div>
    <div class="field"><label for="cfg-tts-baseurl">服务地址</label>
      <input type="text" id="cfg-tts-baseurl" value="${esc(c.tts?.baseUrl || '')}" placeholder="https://api.siliconflow.cn/v1" /></div>
    <div class="field" id="cfg-tts-model-field"><label for="cfg-tts-model">模型</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-tts-model" value="${esc(c.tts?.model || '')}" placeholder="FunAudioLLM/CosyVoice2-0.5B" style="flex:1" />
        <button class="btn btn-small" id="tts-fetch-models-btn" type="button">获取模型列表</button>
      </div>
      <select id="cfg-tts-model-pick" style="display:none;margin-top:6px"></select>
      <div class="hint" id="tts-models-hint" style="display:none"></div></div>
    <div class="field"><label for="cfg-tts-voice">音色（voice）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-tts-voice" value="${esc(c.tts?.voice || '')}" placeholder="FunAudioLLM/CosyVoice2-0.5B:anna" style="flex:1" />
        <button class="btn btn-small" id="tts-voice-pick-btn" type="button">候选音色</button>
      </div>
      <select id="cfg-tts-voice-pick" style="display:none;margin-top:6px"></select>
      <div class="hint" id="tts-voice-hint" style="display:none"></div></div>
    <div class="field" id="tts-director-field" style="display:none"><label for="cfg-tts-director">导演指令（MiMo 用，可选）</label>
      <textarea id="cfg-tts-director" rows="3" placeholder="例如：你是小鲸鱼，声音软一点，像在群里随口聊天，不要播音腔。">${esc(c.tts?.director || '')}</textarea>
      <div class="hint">MiMo 会把它当作导演提示；模型调用 send_voice 时选的 emotion 会自动追加一行情绪。其他供应商忽略这一栏。</div></div>
    <div class="field-row" id="tts-volc-fields" style="display:none">
      <div class="field"><label for="cfg-tts-appid" id="tts-appid-label">AppID（火山）</label>
        <input type="text" id="cfg-tts-appid" value="${esc(c.tts?.appId || '')}" placeholder="语音技术控制台的 AppID" />
        <div class="hint" id="tts-appid-hint"></div>
        <div class="hint" id="tts-appid-warn" style="display:none;color:var(--orange)"></div></div>
      <div class="field" id="tts-cluster-field"><label for="cfg-tts-cluster">Cluster（火山 v1 用）</label>
        <input type="text" id="cfg-tts-cluster" value="${esc(c.tts?.cluster || '')}" placeholder="volcano_tts" />
        <div class="hint">填 <code>volcano_tts</code>；这里是「资源分组」不是音色 —— 填音色名会报 3001/3005。复刻音色（S_ 开头）会自动改用 <code>volcano_icl</code>，不用手改。</div>
        <div class="hint" id="tts-cluster-warn" style="display:none;color:var(--orange)"></div></div>
      <div class="field" id="tts-resourceid-field"><label for="cfg-tts-resourceid">资源 ID（豆包 2.0 用）</label>
        <input type="text" id="cfg-tts-resourceid" value="${esc(c.tts?.resourceId || '')}" placeholder="seed-tts-2.0" />
        <div class="hint">默认 <code>seed-tts-2.0</code>（大模型语音合成 2.0）。1.0 的音色要换成 <code>seed-tts-1.0</code>，要与音色配套；<b>复刻音色（S_ 开头）会自动改用 <code>seed-icl-2.0</code></b>，不用手改。</div>
        <div class="hint" id="tts-resourceid-warn" style="display:none;color:var(--orange)"></div></div>
    </div>
    <div class="hint" id="tts-clone-hint" style="display:none">
      <b>用复刻音色（<code>S_</code> 开头，如 S_xxxxxxxx）时</b>：资源会自动切换（豆包 2.0 → <code>seed-icl-2.0</code>、火山 v1 → <code>volcano_icl</code>），<b>不用手改</b>；
      但账号要先去火山控制台「开通管理」开通<b>「声音复刻2.0字符版」</b> —— <b>后付费音色还要单独开通「后付费音色服务」</b>
      （这是独立的一项），否则首次合成会报 <code>45000030 requested resource not granted</code>，看着就像"没开通"。
      音色 ID 从控制台音色库复制、填到上面的「音色」栏即可。官方投放音色 <code>ICL_uranus_*</code>（首字母大写）不是复刻音色，不用开这项。
    </div>
    <div class="field" id="tts-minimax-fields" style="display:none"><label for="cfg-tts-groupid">GroupId（MiniMax）</label>
      <input type="text" id="cfg-tts-groupid" value="${esc(c.tts?.groupId || '')}" placeholder="账户信息里的 GroupId" /></div>
    <div class="field"><label for="cfg-tts-key" id="tts-key-label">API Key（按供应商分别保存；留空/掩码 = 保持不变）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-tts-key" value="" placeholder="输入新 Key 可替换" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="tts-reveal-key-btn" type="button">显示</button>
      </div>
      <div class="hint" id="tts-key-hint"></div></div>
    <div class="field-row">
      <div class="field"><label for="cfg-tts-speed">语速（0.25~4，1=原速）</label>
        <input type="number" id="cfg-tts-speed" min="0.25" max="4" step="0.05" value="${esc(c.tts?.speed ?? 1)}" /></div>
      <div class="field"><label for="cfg-tts-gain">音量增益 dB（-10~10）</label>
        <input type="number" id="cfg-tts-gain" min="-10" max="10" step="1" value="${esc(c.tts?.gain ?? 0)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="cfg-tts-max">每小时最多合成（次）</label>
        <input type="number" id="cfg-tts-max" min="1" max="200" value="${esc(Number(c.tts?.maxPerHour) > 0 ? Number(c.tts.maxPerHour) : 30)}" />
        <div class="hint">按次/按字符计费的服务在发送限频之前就会消耗额度，默认 30。</div></div>
      <div class="field"><label for="cfg-tts-max-perchat">每会话每小时最多合成（次）</label>
        <input type="number" id="cfg-tts-max-perchat" min="1" max="200" value="${esc(Number(c.tts?.maxPerHourPerChat) > 0 ? Number(c.tts.maxPerHourPerChat) : 6)}" />
        <div class="hint">防止单个群刷爆全局额度，默认 6。</div></div>
    </div>
    <div class="hint">短句 1~3 句最自然；改完先「保存设置」再试听：
      <button class="btn btn-small" id="tts-test-btn" type="button" style="margin-left:8px">试听</button>
      <span id="tts-test-result" class="muted"></span></div>
    <h3 id="settings-imagegen">图片生成（按张计费）</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-enabled" ${c.imageGen?.enabled === true ? 'checked' : ''} />
      <label for="cfg-img-enabled">允许机器人画图（generate_image 工具；默认关）</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-img-autosend" ${c.imageGen?.autoSend !== false ? 'checked' : ''} />
      <label for="cfg-img-autosend">生成后直接发到当前会话（关掉则只存入表情库）</label></div>
    <div class="hint">开启后群友说「画一张」时，机器人会调用服务商的生图接口生成图片。默认生成后直接发出；
      关掉自动发送后，图片只进表情库，模型需要时再调 send_sticker。这是<strong>按张计费</strong>的，
      每小时上限是唯一的闸门，模型不会主动生成，仅在收到请求时调用。</div>
    <div class="field"><label for="cfg-img-send-as">生成后发送格式</label>
      <select id="cfg-img-send-as">
        <option value="sticker" ${c.imageGen?.sendAs === 'image' ? '' : 'selected'}>表情包（默认，与以前一致）</option>
        <option value="image" ${c.imageGen?.sendAs === 'image' ? 'selected' : ''}>普通图片（群友可以直接保存）</option>
      </select>
      <div class="hint">只影响 generate_image 自动发送的图；表情库手动发表情不受影响。</div></div>
    <div class="field"><label for="cfg-img-service">服务预设</label>
      <select id="cfg-img-service"><option value="">（加载中…）</option></select>
      <div class="hint" id="img-preset-hint"></div></div>
    <div class="field"><label for="cfg-img-baseurl">服务地址（填到 /v1，不要带 /images/generations）</label>
      <input type="text" id="cfg-img-baseurl" value="${esc(c.imageGen?.baseUrl || '')}" placeholder="留空 = 与聊天模型同一家（同域时才复用它的 Key）" /></div>
    <div class="field-row">
      <div class="field"><label for="cfg-img-model">模型</label>
        <input type="text" id="cfg-img-model" value="${esc(c.imageGen?.model || '')}" placeholder="如 gpt-image-1 / seedream-3.0 / cogview-3" /></div>
    <div class="field"><label for="cfg-img-size">尺寸（可选）</label>
      <input type="text" id="cfg-img-size" value="${esc(c.imageGen?.size || '')}" placeholder="如 1024x1024；留空用服务商默认" /></div>
    </div>
    <div class="field"><label for="cfg-img-extra-body">自定义请求参数（JSON，可选）</label>
      <textarea id="cfg-img-extra-body" rows="3" style="width:100%" placeholder='例如 {"output_watermark": {"enabled": false}}。留空 = 不附加。'>${esc(extraBodyText(c.imageGen?.extraBody))}</textarea>
      <div class="hint" id="cfg-img-extra-body-hint">会原样合并进生图请求体，适合服务商文档里的 output_watermark、quality 这类参数；同名键会覆盖上面的模型、尺寸和 n。只填 JSON 对象，留空 = 不附加。Moss 示例：{"output_watermark": {"enabled": false}}（官方是嵌套对象）</div>
    </div>
    <div class="field-row">      <div class="field"><label for="cfg-img-max">每小时最多生成（张）</label>
        <input type="number" id="cfg-img-max" min="1" max="100" value="${esc(c.imageGen?.maxPerHour ?? 6)}" />
        <div class="hint">按张计费服务的硬闸门（全局共享）。默认 6；不确定就填小一点。</div></div>
      <div class="field"><label for="cfg-img-response-format">返回格式</label>
        <select id="cfg-img-response-format">
          <option value="" ${!c.imageGen?.responseFormat ? 'selected' : ''}>服务商默认（最兼容）</option>
          <option value="b64_json" ${c.imageGen?.responseFormat === 'b64_json' ? 'selected' : ''}>b64_json</option>
          <option value="url" ${c.imageGen?.responseFormat === 'url' ? 'selected' : ''}>url</option>
        </select>
        <div class="hint">新版 OpenAI 可能因未知参数 400，留空最稳；网关明确要求时再选。</div></div>
      <div class="field"><label for="cfg-img-timeout">单张超时（秒）</label>
        <input type="number" id="cfg-img-timeout" min="10" max="240" step="5" value="${esc(Math.round((Number(c.imageGen?.timeoutMs) > 0 ? Number(c.imageGen.timeoutMs) : 120000) / 1000))}" />
        <div class="hint">生图比对话慢，默认 120 秒；整轮还受「模型 API → 单次运行总超时」限制。</div></div>
      <div class="field"><label for="cfg-img-key" id="cfg-img-key-label">API Key（留空/掩码 = 保持不变）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-img-key" value="" placeholder="留空 = 与模型同域时复用模型 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-img-reveal-key-btn" type="button">显示</button>
        </div>
        <div class="hint" id="cfg-img-key-hint"></div></div>
    </div>
    <div class="hint">改完先「保存设置」再试画一张：
      <button class="btn btn-small" id="img-test-btn" type="button" style="margin-left:8px">试画一张</button>
      <span id="img-test-result" class="muted"></span></div>`;
}

// ── 图片生成：服务预设 ──
// 预设表在后端 src/llm/image-gen-presets.js（前端的模型/ASR 预设表在 core/constants.js，
// TTS 与生图这两套因为后端也要用同一份判断——Key 归属、请求形状——所以放后端）。
// 免 Key 的那家（pollinations）会把 Key 栏置灰并写明不用填。
async function bindImageGenPreset() {
  const svc = document.querySelector('#cfg-img-service');
  if (!svc) return;
  const q = (sel) => document.querySelector(sel);
  const baseInput = q('#cfg-img-baseurl');
  const modelInput = q('#cfg-img-model');
  const hint = q('#img-preset-hint');
  const keyInput = q('#cfg-img-key');
  const keyLabel = q('#cfg-img-key-label');
  const revealBtn = q('#cfg-img-reveal-key-btn');
  let services = [];
  let presetsOk = true;
  try {
    const r = await api('/api/imagegen/presets');
    services = Array.isArray(r?.services) ? r.services : [];
  } catch { presetsOk = false; }
  if (!services.length) presetsOk = false;
  const hostOf = (u) => { try { return new URL(String(u || '').trim()).host.toLowerCase(); } catch { return ''; } };
  const match = (url) => {
    const h = hostOf(url);
    return h ? (services.find((s) => (s.hosts || []).includes(h)) || null) : null;
  };
  const apply = (s, { resetModel = false } = {}) => {
    if (!s) return;
    // 自定义那家没有预设地址：别把上一家的地址留在框里（否则会一直解析回上一家）
    if (s.baseUrl) { if (baseInput) baseInput.value = s.baseUrl; }
    else if (baseInput && match(baseInput.value)) baseInput.value = '';
    const defModel = s.models?.[0]?.id || '';
    if (modelInput) {
      const curModel = String(modelInput.value || '').trim();
      if (defModel && (resetModel || !curModel)) {
        modelInput.value = defModel;
      } else if (resetModel && !defModel) {
        // 魔搭/自定义这类没有内置模型的预设：必须清掉上一家的模型名，
        // 否则会把「Qwen/...」原样发给只认自己模型 id 的下一家（与 TTS 音色串用同型）。
        modelInput.value = '';
      }
    }
    if (hint) hint.textContent = s.note || '';
    const needsKey = Array.isArray(s.creds) && s.creds.length > 0;
    if (keyInput) {
      keyInput.disabled = !needsKey;
      keyInput.placeholder = needsKey ? '留空 = 与模型同域时复用模型 Key' : '这家不需要 Key';
    }
    if (keyLabel) keyLabel.textContent = needsKey ? 'API Key（掩码 = 用这家存过的；留空 = 这家还没存过，要填）' : 'API Key（这家不需要）';
    if (revealBtn) revealBtn.disabled = !needsKey;
    // Key 框跟着预设切（2026-10-02 用户要求）：这家（主机）存过就显示掩码 —— 保存时服务端
    // 会把这家存过的那把取回；没存过就留空等着填。掩码/留空都不会把别家的 Key 发出去。
    const targetHost = hostOf(s.baseUrl || baseInput?.value || '');
    const keyHosts = Array.isArray(state.config?.imageGen?.keyHosts) ? state.config.imageGen.keyHosts : [];
    if (keyInput && needsKey) {
      keyInput.value = targetHost && keyHosts.includes(targetHost) ? '******' : '';
    }
  };
  if (!presetsOk) {
    // 拉不到预设表时**什么都不动**。以前这里退化成"只有 pollinations 一家"，
    // 于是 match() 认不出用户已存的地址 → current 落到 services[0] → apply() 把已存的
    // 地址静默改成 pollinations（保存后就真改了配置）。2026-10-01 审查。
    svc.innerHTML = '<option value="">（预设表拉取失败）</option>';
    if (hint) hint.textContent = '没能从服务端取到服务预设表：已保存的地址、模型与 Key 都不受影响，刷新页面重试即可。';
    return;
  }
  svc.innerHTML = services.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
  const current = match(baseInput?.value) || services.find((s) => s.id === 'custom') || services[0];
  if (current) svc.value = current.id;
  apply(current, { resetModel: !String(modelInput?.value || '').trim() });
  svc.addEventListener('change', () => apply(services.find((x) => x.id === svc.value), { resetModel: true }));
}

// ── 语音回复（TTS）：服务预设与模型/音色候选 ──
// 预设表（每家的常用模型与音色）放在后端 src/llm/tts-presets.js，这里拉取后填下拉与 datalist，
// 前端不另抄一份（抄一份就会有"改了表忘了改另一处"的漂移）。音色没有可查的接口（两家都实测 404），
// 只能内置；模型可点「获取模型列表」从官网拉全量。
async function bindTtsControls() {
  const svc = document.querySelector('#cfg-tts-service');
  if (!svc) return;
  const q = (sel) => document.querySelector(sel);
  const baseUrlInput = q('#cfg-tts-baseurl');
  const modelInput = q('#cfg-tts-model');
  const modelPick = q('#cfg-tts-model-pick');
  const voiceInput = q('#cfg-tts-voice');
  const voicePick = q('#cfg-tts-voice-pick');
  const presetHint = q('#tts-preset-hint');
  const voiceHint = q('#tts-voice-hint');
  const hostOf = (u) => { try { return new URL(String(u || '').trim()).host.toLowerCase(); } catch { return ''; } };
  const pathOf = (u) => { try { return new URL(String(u || '').trim()).pathname.toLowerCase(); } catch { return ''; } };
  let services = [];
  try {
    const r = await api('/api/tts/presets');
    services = Array.isArray(r?.services) ? r.services : [];
  } catch { /* 拉不到就用最小回退 */ }
  if (!services.length) {
    services = [{ id: 'siliconflow', label: '硅基流动', provider: 'openai', creds: ['key'], baseUrl: 'https://api.siliconflow.cn/v1', hosts: ['api.siliconflow.cn'], models: [{ id: 'FunAudioLLM/CosyVoice2-0.5B', voices: ['anna', 'bella', 'claire', 'diana'] }] }];
  }
  // 地址 → 服务：域名与路径都要认。火山 v1 与豆包 2.0 同域名（靠 /api/v1 与 /api/v3 区分），
  // 只按域名会认错家，保存时 Key 就会存到别家名下（2026-09-28 加豆包时补的）
  const matchService = (url) => {
    const host = hostOf(url);
    if (!host) return null;
    const byHost = services.filter((x) => (x.hosts || []).includes(host));
    if (!byHost.length) return null;
    if (byHost.length === 1) return byHost[0];
    const path = pathOf(url);
    return byHost.find((x) => x.pathContains && path.includes(String(x.pathContains).toLowerCase()))
      || byHost.find((x) => !x.pathContains) || byHost[0];
  };
  const currentService = () => {
    const byUrl = matchService(baseUrlInput?.value || '');
    if (byUrl) return byUrl;
    // 地址不在任何预设主机表里 + 配置是 openai 家族 → 「自定义/自建」。
    // 运行时 ttsServiceOf 是同一口径；不补这条的话，自建配置每次进设置页都被回显成
    // 硅基流动，Key 掩码按错家判断，再保存还会把 Key 存到 siliconflow 名下（2026-09-29 审查 P1）
    const prov = String(state.config?.tts?.provider || '').trim().toLowerCase();
    if (prov === 'mimo') {
      // MiMo 有内置官方地址：手写配置只填 provider 也能用，界面要认出它而不是落到「自定义」
      const mimo = services.find((x) => x.id === 'mimo');
      if (mimo) return mimo;
    }
    if (prov === 'openai' || prov === 'custom') {
      const custom = services.find((x) => x.id === 'custom');
      if (custom) return custom;
    }
    return services.find((x) => x.id === svc.value) || services[services.length - 1];
  };
  // 音色两种写法都吃：纯字符串，或 { id, label, cat }（火山/豆包的音色表带中文名与分类）
  const normVoice = (v) => (typeof v === 'string'
    ? { id: v, label: v, cat: '' }
    : { id: String(v?.id || '').trim(), label: String(v?.label || v?.id || '').trim(), cat: String(v?.cat || '').trim() });
  const voiceEntriesFor = (service, model) => {
    const byModel = (service?.models || []).find((m) => m.id === model)?.voices || [];
    const list = byModel.length ? byModel : (service?.voicesFlat || []);
    return list.map(normVoice).filter((v) => v.id);
  };
  // 音色写法按家不同：硅基流动 = 模型id:音色；OpenAI/火山/MiniMax = 裸名
  const voiceValueFor = (service, model, voice) => (service?.provider === 'openai' && service?.id === 'siliconflow' && model ? `${model}:${voice}` : voice);
  const fillVoicePick = (service, model) => {
    // 音色优先按模型查；火山/豆包这类"没有模型名"的家用服务级音色表（voicesFlat）
    const entries = voiceEntriesFor(service, model);
    if (voicePick) {
      const opt = (v) => `<option value="${esc(voiceValueFor(service, model, v.id))}">${esc(v.label)}</option>`;
      // 带分类的表（豆包 2.0 的 102 个音色）按分类分组：与火山控制台的音色列表能一一对上
      const cats = [...new Set(entries.map((v) => v.cat).filter(Boolean))];
      voicePick.innerHTML = cats.length > 1
        ? cats.map((cat) => `<optgroup label="${esc(cat)}">${entries.filter((v) => v.cat === cat).map(opt).join('')}</optgroup>`).join('')
        : entries.map(opt).join('');
    }
    if (voiceHint) {
      voiceHint.style.display = entries.length ? 'none' : '';
      voiceHint.textContent = entries.length ? '' : '这一家没有内置音色表：按服务商文档填 voice（MiniMax 如 female-shaonv）。';
    }
    return entries.length;
  };
  const fillModelPick = (ids) => {
    if (!modelPick) return;
    modelPick.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    modelPick.style.display = ids.length ? '' : 'none';
  };
  // 这家存过 Key 没有：看 keyServices（服务端只下发布尔口径，不下发明文）
  const storedKeyServices = () => {
    // 注意：这里在顶层函数里，拿不到渲染函数的 c —— 必须从 state.config 取
    // （2026-09-28 实测踩过：用 c 会抛 ReferenceError，并把它后面的绑定一起打断）
    const conf = state.config || {};
    return Array.isArray(conf.tts?.keyServices)
      ? conf.tts.keyServices
      : (conf.tts?.hasApiKey ? [conf.tts?.currentService] : []);
  };
  const refreshKeyField = (service) => {
    const node = document.querySelector('#cfg-tts-key');
    if (!node) return;
    const stored = storedKeyServices();
    node.value = service && stored.includes(service.id) ? '******' : '';
  };
  // 各家的凭据字段只在选中那家时出现，并把"填什么、去哪拿"写在旁边
  // （2026-09-28 实测：用户把「资源 ID」填进 AppID、把音色 ID 填进 Cluster，就是因为原来的标签没说清楚）
  const showProviderFields = (service) => {
    const prov = service?.provider || 'openai';
    const isVolcFamily = prov === 'volc' || prov === 'doubao';
    const volcBox = q('#tts-volc-fields');
    if (volcBox) volcBox.style.display = isVolcFamily ? '' : 'none';
    const cloneHint = q('#tts-clone-hint');
    if (cloneHint) cloneHint.style.display = isVolcFamily ? '' : 'none';
    const clusterField = q('#tts-cluster-field');
    if (clusterField) clusterField.style.display = prov === 'volc' ? '' : 'none';
    const resField = q('#tts-resourceid-field');
    if (resField) resField.style.display = prov === 'doubao' ? '' : 'none';
    const appidLabel = q('#tts-appid-label');
    if (appidLabel) appidLabel.textContent = prov === 'doubao' ? 'AppID（豆包 2.0：可留空）' : 'AppID（火山 v1 必填）';
    const appidHint = q('#tts-appid-hint');
    if (appidHint) {
      appidHint.textContent = prov === 'doubao'
        ? '豆包 2.0 默认走 API Key 鉴权，AppID 不是必需的；只有在改用「AppID + Access Token」鉴权时才填（纯数字）。'
        : '语音技术 → 应用管理里的一串数字（如 1234567890）。别把「资源 ID」或音色名填进来 —— 那两样是另一个参数。';
    }
    const keyLabel = q('#tts-key-label');
    if (keyLabel) {
      keyLabel.textContent = prov === 'doubao'
        ? 'API Key（豆包 2.0；按供应商分别保存，留空/掩码 = 保持不变）'
        : (prov === 'volc'
          ? 'Access Token（火山 v1；按供应商分别保存，留空/掩码 = 保持不变）'
          : 'API Key（按供应商分别保存；留空/掩码 = 保持不变）');
    }
    const keyHint = q('#tts-key-hint');
    if (keyHint) {
      const link = service?.keyUrl
        ? `（<a href="${esc(service.keyUrl)}" target="_blank" rel="noreferrer">打开火山控制台 → 语音技术</a>）`
        : '';
      const stored = storedKeyServices();
      const volcOnly = !stored.includes('doubao') && stored.includes('volc');
      keyHint.innerHTML = prov === 'doubao'
        ? `填控制台里的密钥 ${link}：豆包 2.0 走 X-Api-Key 鉴权，不需要填 Cluster。`
          + (volcOnly ? ' 你之前给「火山 v1」存过一把 Key（两套凭据不是同一个，需要重新粘一次）：切到那家点「显示」复制过来即可。' : '')
        : (prov === 'volc' ? `填「应用管理」里的 Access Token ${link} —— 不是 AppID，也不是音色。` : '');
      keyHint.style.display = keyHint.textContent.trim() ? '' : 'none';
    }
    const mmBox = q('#tts-minimax-fields');
    if (mmBox) mmBox.style.display = prov === 'minimax' ? '' : 'none';
    const directorField = q('#tts-director-field');
    if (directorField) directorField.style.display = prov === 'mimo' ? '' : 'none';
    if (keyLabel && prov === 'mimo') {
      keyLabel.textContent = 'API Key（MiMo token-plan；按供应商分别保存，留空/掩码 = 保持不变）';
    }
    if (keyHint && prov === 'mimo') {
      keyHint.textContent = '填 token-plan 的 API Key（请求头是 api-key，不是 Bearer）。'
        + '模型用 mimo-v2.5-tts，音色先在控制台确认已开通；服务地址填到 /v1 即可。';
      keyHint.style.display = '';
    }
    // 模型栏：这一家不要模型名就整栏藏掉（火山 v1 / 豆包）；「自定义/自建」虽然 models 为空
    // 但**必须填模型名**（note 里写了），也保留；有内置模型但不支持拉取的（MiniMax）
    // 留输入框 + 内置候选，只把「获取模型列表」按钮藏掉
    const modelField = q('#cfg-tts-model-field');
    const needsModelField = (service?.models || []).length > 0 || service?.id === 'custom';
    if (modelField) modelField.style.display = needsModelField ? '' : 'none';
    const fetchBtnEl = q('#tts-fetch-models-btn');
    if (fetchBtnEl) fetchBtnEl.style.display = prov === 'openai' && service?.id !== 'custom' ? '' : 'none';
  };
  // 实时校验火山的三个框：把"填错位置"当场指出来（用户实测就把资源 ID 填进了 AppID、音色填进了 Cluster）
  const validateVolcFields = () => {
    const prov = currentService()?.provider || 'openai';
    const setWarn = (sel, msg) => {
      const node = q(sel);
      if (!node) return;
      node.style.display = msg ? '' : 'none';
      node.textContent = msg || '';
    };
    const appid = String(q('#cfg-tts-appid')?.value || '').trim();
    const cluster = String(q('#cfg-tts-cluster')?.value || '').trim();
    const resId = String(q('#cfg-tts-resourceid')?.value || '').trim();
    setWarn('#tts-appid-warn', prov === 'volc' && appid && !/^\d{5,15}$/.test(appid)
      ? '看起来不是 AppID（应为纯数字）。seed-tts-2.0 这类是「资源 ID」，不属于这里。' : '');
    setWarn('#tts-cluster-warn', cluster && !/^volcano_/i.test(cluster)
      ? `「${cluster}」看着像音色/资源 ID，不是 cluster：这里固定填 volcano_tts（音色请填到「音色」栏）。` : '');
    setWarn('#tts-resourceid-warn', resId && !/^(seed-(tts|icl)-|volc\.)/i.test(resId)
      ? '资源 ID 形如 seed-tts-2.0 / seed-tts-1.0 / seed-icl-2.0（复刻音色）/ volc.service_type.xxxx。' : '');
    // 豆包模式下填了纯数字 AppID 不是错误，但鉴权套件变了，必须说清 Key 栏该填什么
    if (prov === 'doubao' && /^\d{5,15}$/.test(appid)) {
      setWarn('#tts-appid-warn', 'AppID 已填：豆包将改走「AppID + Access Token」鉴权 —— 此时下面的 API Key 栏要填 Access Token，不是控制台密钥；留空 AppID 则走 X-Api-Key（控制台密钥）。');
    }
  };
  const renderFor = (service, { resetModel = false, restoreVoice = false } = {}) => {
    if (!service) return;
    const models = service.models || [];
    fillModelPick(models.map((m) => m.id));
    if (resetModel || !String(modelInput?.value || '').trim()) {
      if (modelInput && models[0]?.id) modelInput.value = models[0].id;
      // 换家后别把上一家的模型名留在框里（火山/豆包不用模型名，留着会被当参数发出去）。
      // 「自定义/自建」也一样：MiMo 的模型名发给自建网关只会 404；清空后占位符会提示必填
      //（2026-09-29 曾为了"必填"故意保留，结果就是跨服务串用，2026-10-26 复审改掉）。
      if (modelInput && !models.length) modelInput.value = '';
    }
    if (modelInput) modelInput.placeholder = (models.length || service?.id === 'custom') ? 'FunAudioLLM/CosyVoice2-0.5B' : '（这家不需要模型名）';
    const model = String(modelInput?.value || '').trim();
    // 换家后音色若不在新家候选里（比如从硅基流动切到火山），顺手换成第一个候选并说明，
    // 否则会把上一家的音色原样发过去、报错还看不懂
    const entries = voiceEntriesFor(service, model);
    let voiceNote = '';
    if (voiceInput) {
      const cur = String(voiceInput.value || '').trim();
      const values = entries.map((v) => voiceValueFor(service, model, v.id));
      if (restoreVoice) {
        // 切换服务预设时按"这家上次用的音色"恢复；没有记忆才退到第一个候选。
        // 否则从 MiMo 切到豆包会把 Chloe 原样发过去（2026-10-26 用户反馈）。
        const remembered = String((state.config?.tts?.voices || {})[service.id] || '').trim();
        if (remembered) {
          voiceInput.value = remembered;
          if (remembered !== cur) voiceNote = `已恢复「${service.label}」上次保存的音色。`;
        } else if (values.length && (!cur || !values.includes(cur))) {
          voiceInput.value = values[0];
          voiceNote = `「${service.label}」还没保存过音色，已先选第一个候选；确认后保存。`;
        } else if (!cur && values.length) {
          voiceInput.value = values[0];
        }
      } else if (!cur && values.length) {
        voiceInput.value = values[0];      // 空着就填一个默认，省得用户面对空框
      } else if (cur && values.length && !values.includes(cur)) {
        // 不在候选里：**任何时候都不擅自改值** —— 官方投放音色（ICL_uranus_*）与自己复刻的音色（S_ 开头）
        // 都不在内置表里，自动替换等于把用户的音色弄丢（2026-09-29 实测踩过）。只提示，由用户自己决定。
        voiceNote = `当前音色「${cur}」不在这一家的内置候选里 —— 官方投放/自定义/复刻音色若这一家支持可照用；不确定就点「候选音色」重选，改完记得保存。`;
      }
    }
    fillVoicePick(service, model);
    // 提示必须写在 fillVoicePick 之后：那个函数在有候选时会把 hint 清空
    if (voiceNote && voiceHint) {
      voiceHint.style.display = '';
      voiceHint.textContent = voiceNote;
    }
    if (presetHint) presetHint.textContent = service.note || '';
    showProviderFields(service);
    validateVolcFields();
    refreshKeyField(service);
  };
  // 手打这三个框时也实时校验（不只在校验器里跑一次）
  for (const sel of ['#cfg-tts-appid', '#cfg-tts-cluster', '#cfg-tts-resourceid']) {
    q(sel)?.addEventListener('input', validateVolcFields);
  }
  svc.innerHTML = services.map((x) => `<option value="${x.id}" data-provider="${esc(x.provider || 'openai')}">${esc(x.label)}</option>`).join('');
  const first = currentService();
  if (first) svc.value = first.id;
  renderFor(first);
  svc.addEventListener('change', () => {
    const picked = services.find((x) => x.id === svc.value);
    if (!picked) return;
    if (picked.baseUrl && baseUrlInput) baseUrlInput.value = picked.baseUrl;
    // 切到自定义/自建：地址栏若还留着某个预设的地址就清掉（自建地址用户自己填），
    // 不然 currentService 会一直解析回上一家、候选与 Key 归属全跟着错（2026-09-29 审查 P1）
    if (picked.id === 'custom' && matchService(baseUrlInput?.value || '')) {
      if (baseUrlInput) baseUrlInput.value = '';
    }
    // 切到豆包 2.0 时清掉火山 v1 遗留的 AppID：纯数字 AppID 会让适配器改走
    // AppID+AccessToken 鉴权，把刚填的控制台密钥当 Access Token 用（2026-09-29 审查 P1）
    if (picked.id === 'doubao') {
      const appidNode = q('#cfg-tts-appid');
      if (appidNode && /^\d{5,15}$/.test(String(appidNode.value || '').trim())) appidNode.value = '';
    }
    renderFor(picked, { resetModel: true, restoreVoice: true });
  });
  modelInput?.addEventListener('input', () => fillVoicePick(currentService(), String(modelInput.value || '').trim()));
  modelPick?.addEventListener('change', () => {
    if (modelInput) modelInput.value = modelPick.value;
    fillVoicePick(currentService(), modelPick.value);
    if (modelsHint) { modelsHint.style.display = ''; modelsHint.textContent = `已选择：${modelPick.value}`; }
  });
  const voicePickBtn = q('#tts-voice-pick-btn');
  // 语音合成 Key 的「显示 / 隐藏」不在这里：与设置页其它密钥同走 ui/pages/key-toggles.js
  // 的统一实现。这里的旧实现有两个坑（2026-10-01 审查）：①「显示」会用回读值盖掉用户刚
  // 输了一半的新 Key；②「隐藏」无条件写 ****** —— 而 ****** 在服务端是"保持不变"，
  // 等于把刚粘进去的新 Key 静默丢弃。
  if (voicePickBtn) voicePickBtn.addEventListener('click', () => {
    if (!voicePick) return;
    const service = currentService();
    const count = fillVoicePick(service, String(modelInput?.value || '').trim());
    voicePick.style.display = count ? '' : 'none';
    if (voiceHint) {
      if (count) {
        voiceHint.style.display = '';
        voiceHint.textContent = `已填入 ${count} 个候选音色，选一个即写进上面的输入框`
          + (service?.provider === 'doubao' ? '（音色要账号已开通，未开通会报 resource not granted）' : '')
          + '。';
      } else {
        voiceHint.style.display = '';
        voiceHint.textContent = '这一家没有内置音色表：直接手填 voice（MiniMax 如 female-shaonv）。';
      }
    }
  });
  voicePick?.addEventListener('change', () => { if (voiceInput) voiceInput.value = voicePick.value; });
  const modelsHint = q('#tts-models-hint');
  const fetchBtn = q('#tts-fetch-models-btn');
  if (fetchBtn) fetchBtn.addEventListener('click', async () => {
    if (modelsHint) { modelsHint.style.display = ''; modelsHint.textContent = '拉取中…'; }
    try {
      const keyNode = q('#cfg-tts-key');
      const rawKey = keyNode?.value?.trim() || '';
      const r = await api('/api/tts/models', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: baseUrlInput?.value?.trim() || '',
          apiKey: rawKey === '******' ? '' : rawKey,
          provider: currentService()?.provider || 'openai'
        })
      });
      if (!r.ok) { if (modelsHint) modelsHint.textContent = r.error || '拉取失败'; return; }
      // 这一家没有可拉的模型列表（火山/豆包/MiniMax）：把"该填什么"如实说出来，
      // 而不是显示"共 0 个"让人以为按钮坏了（2026-09-28 用户实测反馈）
      if (r.unsupported || !(r.models || []).length) {
        fillModelPick([]);
        if (modelsHint) modelsHint.textContent = r.note || '这一家没有可拉的模型列表：按服务商文档填。';
        return;
      }
      fillModelPick(r.models || []);
      if (modelsHint) {
        modelsHint.textContent = `共 ${r.models.length} 个${r.ttsOnly ? '（已按语音合成过滤）' : '（没认出语音模型，给的是全量）'}，选一个填进上面的输入框`;
      }
    } catch (e) { if (modelsHint) modelsHint.textContent = `失败：${e.message}`; }
  });
}


export { bindImageGenPreset, bindTtsControls, renderAsrSection };