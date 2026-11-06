// 管理员能力的装配层：把 action store / send / inbox / status / commands 接在一起，
// 并负责把回复发回管理员私聊（正常走发送队列，暂停/观察模式下退回 OneBot HTTP）。
import { adminOwnerUin } from '../core/config.js';
import { sendOwnerText } from '../core/notify-owner.js';
import { createActionStore } from './actions.js';
import { createCommandService } from './commands.js';
import { createInbox } from './inbox.js';
import { createSendService } from './send.js';
import { createStatusService } from './status.js';
import { setAdminServices } from './index.js';

export function createAdminServices({
  dataDir, store, sender, onebot, effects, pluginRegistry,
  getIdentityPilot, getConfig, getMcp, log = () => {}
} = {}) {
  const config = getConfig;
  const logLine = log;
  if (!dataDir || !store || !sender || !onebot || !effects || !getConfig) {
    throw new Error('createAdminServices 缺少依赖');
  }
  const actions = createActionStore({ dataDir });
  const send = createSendService({
    dataDir, store, sender, onebot, effects, actions, getConfig, log
  });
  const inbox = createInbox({
    dataDir, actions, getPluginRegistry: () => pluginRegistry,
    getIdentityPilot, getConfig
  });
  const status = createStatusService({
    dataDir, store, onebot, getConfig,
    getPlugins: () => pluginRegistry,
    getMcp,
    actions
  });

  async function replyOwner(text) {
    const cfg = config();
    const owner = adminOwnerUin(cfg);
    if (!/^\d{5,15}$/.test(owner || '')) return;
    const body = String(text || '').slice(0, 4000);
    if (!body) return;
    try {
      await sender.sendTextBatch(`private:${owner}`, [body], { persona: false });
      return;
    } catch (error) {
      // 暂停/观察模式/非活跃时段下 sender 会拒绝；管理员的状态/审批回复仍应送达。
      const onebotCfg = cfg.onebot || {};
      const fallback = await sendOwnerText({
        httpPort: Number(onebotCfg.httpPort) || 3390,
        httpUrl: String(onebotCfg.httpUrl || ''),
        token: String(onebotCfg.httpAccessToken || onebotCfg.accessToken || ''),
        ownerUin: owner,
        text: body
      }).catch((cause) => ({ ok: false, detail: String(cause?.message ?? cause) }));
      if (!fallback.ok) logLine('[admin] 管理员回复发送失败：', fallback.detail || error?.message || error);
    }
  }

  const commands = createCommandService({
    send, inbox, status, actions, getConfig, reply: replyOwner, log
  });

  async function handlePrivateMessage(event) {
    if (event?.post_type !== 'message' || event?.message_type !== 'private') return false;
    const result = await commands.handle(event);
    if (!result?.handled) return false;
    if (result.reply) await replyOwner(result.reply);
    return true;
  }

  const services = {
    actions, send, inbox, status, commands, replyOwner, handlePrivateMessage
  };
  setAdminServices(services);
  return services;
}
