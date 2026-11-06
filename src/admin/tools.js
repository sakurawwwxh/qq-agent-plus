// 管理员私聊专属工具。工具只“准备/查看”，真正发送必须由固定命令的确认码执行。
import { adminOwnerUin, getConfig } from '../core/config.js';
import { getAdminServices } from './index.js';

function ok(content) {
  return { content, isError: false, reportIncident: false };
}

function err(content) {
  return { content: `错误：${content}`, isError: true, reportIncident: false };
}

export function isAdminPrivate({ kind, chatId, cfg = getConfig() } = {}) {
  const owner = adminOwnerUin(cfg);
  return kind === 'private' && /^\d{5,15}$/.test(owner || '') && String(chatId) === owner;
}

const SEND_PARAMETERS = {
  type: 'object',
  properties: {
    target: {
      description: '目标群：群号或完整群名，或它们的数组（最多 5 个）。只能发到 allow.groups 白名单里的群；白名单只有一个群时可省略。',
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
    },
    items: {
      type: 'array',
      description: '要发送的内容项，按顺序发送。最多 10 项。',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'image', 'forward', 'file', 'voice', 'aiVoice'] },
          text: { type: 'string', description: 'text/aiVoice 的正文' },
          url: { type: 'string', description: 'image/file/voice 的公网 http(s) 地址' },
          messageId: { type: 'string', description: '从管理员私聊里转发已有消息时填消息 id；优先于 url' },
          name: { type: 'string', description: 'file 的文件名' },
          seconds: { type: 'integer', description: 'voice 的秒数（可选）' },
          character: { type: 'string', description: 'aiVoice 的音色（可选）' },
          desc: { type: 'string', description: 'image 的简短描述（可选）' }
        },
        required: ['type']
      }
    },
    messages: {
      description: '快捷写法：只发文字时可直接传字符串或字符串数组（与 items 二选一）。',
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
    }
  },
  required: []
};

export function adminToolDefs({ kind = '', chatId = '', cfg = getConfig() } = {}) {
  if (!isAdminPrivate({ kind, chatId, cfg })) return [];
  return [
    {
      name: 'admin_send',
      description: '（仅全局管理员私聊）准备一次跨群发送。传入目标群和内容项；不会立即发送，'
        + '而是返回预览和 6 位确认码，管理员回复「确认 <码>」后才执行。支持文字、图片、聊天记录卡片、'
        + '文件、语音。图片/文件/语音用私聊里已有消息的 messageId 或公网 http(s) URL，不接受本地路径。'
        + '必须等本工具返回后，再用 send_message 把预览原样发给管理员；不要自己替管理员确认。',
      parameters: SEND_PARAMETERS,
      async execute(ctx, args = {}) {
        const cfg = ctx.cfg || getConfig();
        if (!isAdminPrivate({ kind: ctx.kind, chatId: ctx.chatId, cfg })) {
          return err('只有全局管理员私聊可以使用跨群发送');
        }
        const services = getAdminServices();
        if (!services?.send) return err('管理员发送服务未初始化');
        const items = args.items ?? (args.messages == null ? null
          : (Array.isArray(args.messages) ? args.messages : [args.messages])
            .map((text) => ({ type: 'text', text })));
        if (!args.target && !args.messages && !args.items) return err('需要指定发送内容');
        try {
          const plan = await services.send.plan({
            actor: adminOwnerUin(cfg),
            targetsInput: Array.isArray(args.target) ? args.target : [args.target],
            itemsInput: items,
            source: 'tool'
          });
          return ok(`${plan.preview}\n\n请把这段预览原样发给管理员，等待管理员回复确认码。不要自己确认或发送。`);
        } catch (error) {
          return err(String(error?.message ?? error).slice(0, 400));
        }
      }
    },
    {
      name: 'admin_inbox',
      description: '（仅全局管理员私聊）查看统一审批收件箱：插件待批、入站好友申请、待确认的管理员发送动作。'
        + '返回条目和短码；管理员用「同意 <码>」「拒绝 <码>」或「确认 <码>」处理。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        const cfg = ctx.cfg || getConfig();
        if (!isAdminPrivate({ kind: ctx.kind, chatId: ctx.chatId, cfg })) {
          return err('只有全局管理员私聊可以查看审批收件箱');
        }
        const services = getAdminServices();
        if (!services?.inbox) return err('审批收件箱未初始化');
        return ok(services.inbox.formatList());
      }
    },
    {
      name: 'admin_status',
      description: '（仅全局管理员私聊）查看机器人只读状态：运行模式、OneBot、入站/出站积压、未知发送、插件/MCP、磁盘。'
        + '不包含密钥和配置原文。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        const cfg = ctx.cfg || getConfig();
        if (!isAdminPrivate({ kind: ctx.kind, chatId: ctx.chatId, cfg })) {
          return err('只有全局管理员私聊可以查看状态');
        }
        const services = getAdminServices();
        if (!services?.status) return err('状态服务未初始化');
        return ok(services.status.format());
      }
    }
  ];
}
