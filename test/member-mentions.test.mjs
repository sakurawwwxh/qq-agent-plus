import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-member-mentions-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => rmDirBestEffort(dir));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue, buildMentionParts } = await import('../src/onebot/sender.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

function withStore(t) {
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => store.close());
  store.appendIncoming('group:1', { mid: 1, senderId: '42', senderName: '张三', text: 'hi', ts: 1000 });
  store.appendIncoming('group:1', { mid: 2, senderId: '43', senderName: '张三四', text: 'hi', ts: 2000 });
  store.appendIncoming('group:1', { mid: 3, senderId: '44', senderName: '小明', text: 'hi', ts: 3000 });
  store.appendIncoming('group:1', { mid: 4, senderId: '45', senderName: '小明', text: 'hi', ts: 4000 });
  store.appendIncoming('group:1', { mid: 5, senderId: '46', senderName: '李四', text: 'hi', ts: 4500 });
  store.appendIncoming('group:1', { mid: 6, senderId: '47', senderName: 'qq', text: 'hi', ts: 4600 });
  store.appendIncoming('group:1', { mid: 7, senderId: '48', senderName: '喵', text: 'hi', ts: 4700 });
  store.appendIncoming('private:9', { mid: 8, senderId: '42', senderName: '张三', text: 'hi', ts: 5000 });
  return store;
}

test('memberNames / memberByName / personChatIndex：唯一命中才认人', (t) => {
  const store = withStore(t);
  const names = store.memberNames('group:1');
  assert.equal(names.find((m) => m.userId === '42').name, '张三');
  assert.equal(names.find((m) => m.userId === '43').name, '张三四');
  const exact = store.memberByName('group:1', '@张三');
  assert.equal(exact.userId, '42');
  assert.equal(exact.name, '张三');
  assert.equal(store.memberByName('group:1', '李').userId, '46', '前缀唯一命中');
  assert.equal(store.memberByName('group:1', '张'), null, '前缀命中多个不能猜');
  assert.equal(store.memberByName('group:1', '小明'), null, '重名不能猜');

  const index = store.personChatIndex(['42', '43', 'bad']);
  assert.deepEqual(index['42'].map((x) => x.chatKey).sort(), ['group:1', 'private:9']);
  assert.equal(index['43'][0].chatKey, 'group:1');
  assert.deepEqual(index.bad, undefined);
});

test('buildMentionParts：已知昵称转 at 段，未知/重名/邮箱保持原文', () => {
  const members = [
    { userId: '42', name: '张三' },
    { userId: '43', name: '张三四' },
    { userId: '44', name: '小明' },
    { userId: '45', name: '小明' },
    { userId: '47', name: 'qq' },
    { userId: '48', name: '喵' }
  ];
  assert.deepEqual(buildMentionParts('@张三四 你看这个', members), [
    { type: 'at', qq: '43' },
    { type: 'text', text: ' 你看这个' }
  ]);
  assert.deepEqual(buildMentionParts('你好@张三，看下', members), [
    { type: 'text', text: '你好' },
    { type: 'at', qq: '42' },
    { type: 'text', text: '，看下' }
  ]);
  assert.equal(buildMentionParts('@张三丰 你看', members), null, '不能把更长名字的前缀当 mention');
  assert.equal(buildMentionParts('mail a@张三.com', members), null);
  assert.equal(buildMentionParts('张三@qq.com', members), null, '邮箱里的名字不能被拆成 at');
  assert.equal(buildMentionParts('@小明 你看', members), null, '重名保持原文');
  assert.equal(buildMentionParts('@不存在 你看', members), null);
  assert.deepEqual(buildMentionParts('@喵 你看', members), [
    { type: 'at', qq: '48' },
    { type: 'text', text: ' 你看' }
  ], '单字昵称在空格边界下仍可 mention');
});

test('sendTextBatch：群聊正文 @昵称 走 sendRichText，私聊不展开', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.allow.private = ['9'];
  cfg.humanize = { ...(cfg.humanize || {}), enabled: false };
  setRuntimeConfig(cfg);
  const store = withStore(t);
  const sent = [];
  const onebot = {
    sendRichText: async (...args) => { sent.push(['rich', ...args]); return { message_id: 11 }; },
    sendText: async (...args) => { sent.push(['text', ...args]); return { message_id: 12 }; }
  };
  const sender = new SendQueue({ store, onebot });
  const result = await sender.sendTextBatch('group:1', ['@张三 看这个'], {});
  assert.equal(result.sent.length, 1);
  assert.equal(sent[0][0], 'rich');
  assert.deepEqual(sent[0][3], [{ type: 'at', qq: '42' }, { type: 'text', text: ' 看这个' }]);

  const privateResult = await sender.sendTextBatch('private:9', ['@张三 看这个'], {});
  assert.equal(privateResult.sent.length, 1);
  assert.equal(sent[1][0], 'text', '私聊不展开 at');
});

test('成员表读取失败时降级为纯文本，不阻断发送', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.humanize = { ...(cfg.humanize || {}), enabled: false };
  setRuntimeConfig(cfg);
  const store = withStore(t);
  store.memberNames = () => { throw new Error('disk I/O error'); };
  const sent = [];
  const onebot = {
    sendText: async (...args) => { sent.push(['text', ...args]); return { message_id: 12 }; }
  };
  const sender = new SendQueue({ store, onebot });
  const result = await sender.sendTextBatch('group:1', ['@张三 看这个'], {});
  assert.equal(result.sent.length, 1);
  assert.equal(sent[0][0], 'text');
});

test('群成员名单：从未发言的成员也能被 @，协议端失败时退回消息表', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.humanize = { ...(cfg.humanize || {}), enabled: false };
  setRuntimeConfig(cfg);
  const store = withStore(t);
  let memberNameCalls = 0;
  const originalMemberNames = store.memberNames.bind(store);
  store.memberNames = (...args) => {
    memberNameCalls += 1;
    return originalMemberNames(...args);
  };
  const sent = [];
  let directoryCalls = 0;
  const onebot = {
    getGroupMemberList: async () => {
      directoryCalls += 1;
      return [{ user_id: 99, nickname: '潜水员' }];
    },
    sendRichText: async (...args) => { sent.push(['rich', ...args]); return { message_id: 11 }; },
    sendText: async (...args) => { sent.push(['text', ...args]); return { message_id: 12 }; }
  };
  const sender = new SendQueue({ store, onebot });
  const result = await sender.sendTextBatch('group:1', ['@潜水员 你好'], {});
  assert.equal(result.sent.length, 1);
  assert.equal(directoryCalls, 1);
  assert.equal(memberNameCalls, 0, '完整名单可用时不应再扫消息表');
  assert.deepEqual(sent[0][3], [{ type: 'at', qq: '99' }, { type: 'text', text: ' 你好' }]);

  // 第二次命中 10 分钟缓存，不再拉名单，也不扫消息表。
  await sender.sendTextBatch('group:1', ['@潜水员 再问一句'], {});
  assert.equal(directoryCalls, 1);
  assert.equal(memberNameCalls, 0);
});
