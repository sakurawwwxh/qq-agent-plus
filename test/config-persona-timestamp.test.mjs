// 人设 changedAt 只能由服务端写：__replace__ 形态也必须删掉客户端字段。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootConsole } from './helpers/console-boot.mjs';

test('persona.__replace__ 里伪造的 changedAt 不会生效', async (t) => {
  const { request, app } = await bootConsole(t);
  const res = await request('POST', '/api/config', {
    persona: { __replace__: { roleText: '新的角色卡', changedAt: 1 } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const persona = app.getConfig().persona;
  assert.equal(persona.roleText, '新的角色卡');
  assert.notEqual(persona.changedAt, 1, '客户端时间戳必须被丢弃');
  assert.ok(Number(persona.changedAt) > Date.now() - 60_000, '服务端应写入当前时间');
});
