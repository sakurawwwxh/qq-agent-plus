// MCP 沙箱启动参数的决策矩阵：docker 不许假隔离、npx 优先 bwrap、required fail-closed。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { rmDirBestEffort } from './helpers/cleanup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-sandbox-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => rmDirBestEffort(root));

const { buildMcpLaunchSpec, resetSandboxProbes, bwrapSupported } = await import('../src/mcp/sandbox.js');

const OK = { ok: true, error: '' };
const NO_BWRAP = { ok: false, error: '未安装 bubblewrap（bwrap）' };
const NO_DOCKER = { ok: false, error: 'Docker 不可用：daemon 未启动' };
const NO_NET = { ok: false, error: '本平台没有 unshare/netns' };

test('docker：绝不套 CLI netns，强制 --network none + 只读根 + cap-drop', () => {
  const spec = buildMcpLaunchSpec({
    id: 'docker-fs',
    command: 'docker',
    args: ['run', '--rm', '-i', 'mcp/filesystem:latest', '/data'],
    sandbox: { mode: 'required', network: 'none' },
    probeDocker: OK
  });
  assert.equal(spec.command, 'docker');
  assert.equal(spec.args[0], 'run');
  assert.ok(!spec.args.includes('unshare'), '不能把 docker CLI 关进 netns 冒充隔离');
  const joined = spec.args.join(' ');
  assert.match(joined, /--network none/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--cap-drop=ALL/);
  assert.match(joined, /--security-opt=no-new-privileges/);
  assert.match(joined, /--cidfile=/);
  assert.equal(spec.sandboxKind, 'docker');
  assert.equal(spec.netIsolated, true);
  assert.equal(spec.fsIsolated, true);
  assert.ok(spec.cleanup?.cidFile);
});

test('docker：privileged / host 网络 / 挂载 / docker.sock 一律拒绝', () => {
  const base = {
    id: 'docker-bad', command: 'docker', probeDocker: OK,
    sandbox: { mode: 'required', network: 'none' }
  };
  for (const args of [
    ['run', '--privileged', 'img'],
    ['run', '--network=host', 'img'],
    ['run', '-v', '/:/host', 'img'],
    ['run', '-v/:/host', 'img'],
    ['run', '--volume=/etc:/etc', 'img'],
    ['run', '--volumes-from', 'other', 'img'],
    ['run', '--security-opt=seccomp=unconfined', 'img'],
    ['run', '-p', '8080:80', 'img'],
    ['run', '--mount', 'type=bind,src=/etc,dst=/etc', 'img'],
    ['run', '--device', '/dev/sda', 'img'],
    ['run', '--cap-add=SYS_ADMIN', 'img'],
    ['run', '-itv', '/:/host', 'img'],
    ['run', '-itv/:/host', 'img'],
    ['run', '--read-only=false', 'img'],
    ['run', '--pids-limit=-1', 'img'],
    ['run', '--memory=8g', 'img'],
    ['run', '--tmpfs', '/data:rw', 'img'],
    ['run', '-v', '/var/run/docker.sock:/var/run/docker.sock', 'img']
  ]) {
    assert.throws(() => buildMcpLaunchSpec({ ...base, args }), /隔离配置不成立/, args.join(' '));
  }
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, args: ['run', 'img'], sandbox: { mode: 'required', network: 'host' } }),
    /host 网络/
  );
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, args: ['run', 'img'], probeDocker: NO_DOCKER }),
    /Docker 不可用/
  );
});

test('docker：没写 sandbox.network 时默认 none，而不是被 host 默认值挡死', () => {
  const spec = buildMcpLaunchSpec({
    id: 'docker-default', command: 'docker', args: ['run', 'img'], probeDocker: OK
  });
  assert.match(spec.args.join(' '), /--network none/);
  assert.equal(spec.netIsolated, true);
});

test('bwrap：cwd/writablePaths 不能与数据目录重叠（含父目录与软链）', () => {
  const base = {
    id: 'bwrap-paths', command: 'npx', args: ['-y', 'pkg'],
    sandbox: { mode: 'required', network: 'none' },
    platform: 'linux', probeBwrap: OK
  };
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, cwd: root }),
    /cwd 不能与数据目录重叠/,
    '数据目录本身不能当 cwd'
  );
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, cwd: path.parse(root).root }),
    /cwd 不能与数据目录重叠/,
    '文件系统根目录会把整个宿主只读挂进沙箱'
  );
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, sandbox: { mode: 'required', network: 'none', writablePaths: [os.tmpdir()] } }),
    /writablePaths 不能与数据目录重叠/,
    '数据目录的父目录可写等于数据目录可写'
  );
});

test('npx：Linux 有 bwrap 时用只读根 + 独立 netns，HOME/缓存指向沙箱内', () => {
  const spec = buildMcpLaunchSpec({
    id: 'npx-bwrap',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    sandbox: { mode: 'required', network: 'none' },
    platform: 'linux',
    probeBwrap: OK
  });
  assert.equal(spec.command, 'bwrap');
  const joined = spec.args.join(' ');
  assert.match(joined, /--unshare-all/);
  if (process.platform === 'linux') assert.match(joined, /--ro-bind \/usr \/usr/);
  assert.match(joined, /--tmpfs \/tmp/);
  assert.ok(spec.args.includes('npx'));
  assert.equal(spec.env.HOME, '/tmp/home');
  assert.equal(spec.env.npm_config_offline, 'true');
  assert.equal(spec.netIsolated, true);
  assert.equal(spec.fsIsolated, true);
  assert.equal(spec.sandboxKind, 'bwrap');
  assert.ok(spec.cleanup?.tempHome);
  assert.equal(fs.existsSync(spec.cleanup.tempHome), true);
  fs.rmSync(spec.cleanup.tempHome, { recursive: true, force: true });
});

test('networkIsolation 优先于矛盾的 sandbox.mode/network，不能静默裸跑', () => {
  const npxSpec = buildMcpLaunchSpec({
    id: 'legacy-net',
    command: 'npx',
    args: ['-y', 'pkg'],
    networkIsolation: true,
    sandbox: { mode: 'off', network: 'host' },
    platform: 'linux',
    probeBwrap: OK
  });
  assert.equal(npxSpec.netIsolated, true);
  assert.equal(npxSpec.unsandboxed, false);
  assert.equal(npxSpec.sandboxKind, 'bwrap');

  const nodeSpec = buildMcpLaunchSpec({
    id: 'legacy-node-net',
    command: 'node',
    args: ['server.js'],
    networkIsolation: true,
    sandbox: { mode: 'off', network: 'host' },
    netProbe: OK
  });
  assert.equal(nodeSpec.command, 'unshare');
  assert.equal(nodeSpec.netIsolated, true);
  assert.equal(nodeSpec.unsandboxed, false);
});

test('npx：没有 bwrap 时 required fail-closed，auto 需要 allowUnsandboxed', () => {
  const base = {
    id: 'npx-nobwrap',
    command: 'npx',
    args: ['-y', 'pkg'],
    platform: 'linux',
    probeBwrap: NO_BWRAP
  };
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, sandbox: { mode: 'required', network: 'none' } }),
    /required\/未显式信任时拒绝/
  );
  assert.throws(
    () => buildMcpLaunchSpec({ ...base, sandbox: { mode: 'auto', network: 'none' } }),
    /required\/未显式信任时拒绝/
  );
  const trusted = buildMcpLaunchSpec({
    ...base,
    sandbox: { mode: 'auto', network: 'none' },
    allowUnsandboxed: true
  });
  assert.equal(trusted.unsandboxed, true);
  assert.equal(trusted.sandboxKind, 'none');
});

test('node：网络隔离仍走 unshare；隔离环境剥掉 NODE_OPTIONS/LD_*', () => {
  const spec = buildMcpLaunchSpec({
    id: 'node-net',
    command: 'node',
    args: ['server.js'],
    env: { NODE_OPTIONS: '--require /tmp/evil.js', LD_PRELOAD: '/tmp/evil.so', KEEP: '1' },
    sandbox: { mode: 'required', network: 'none' },
    netProbe: OK
  });
  assert.equal(spec.command, 'unshare');
  assert.deepEqual(spec.args.slice(0, 5), ['--user', '--map-root-user', '--net', 'node', 'server.js']);
  assert.equal(spec.netIsolated, true);
  assert.equal(spec.env.KEEP, '1');
  assert.equal('NODE_OPTIONS' in spec.env, false);
  assert.equal('LD_PRELOAD' in spec.env, false);
});

test('node：required 但没开任何隔离 → fail-closed；netns 不可用也 fail-closed', () => {
  assert.throws(
    () => buildMcpLaunchSpec({
      id: 'node-bare', command: 'node', args: ['server.js'],
      sandbox: { mode: 'required', network: 'host' }
    }),
    /required 模式至少要启用/
  );
  assert.throws(
    () => buildMcpLaunchSpec({
      id: 'node-nonet', command: 'node', args: ['server.js'],
      sandbox: { mode: 'required', network: 'none' },
      netProbe: NO_NET
    }),
    /unshare\/netns/
  );
});

test('mode off：不启用沙箱（管理员显式选择）', () => {
  resetSandboxProbes();
  const spec = buildMcpLaunchSpec({
    id: 'off',
    command: 'some-binary',
    sandbox: { mode: 'off', network: 'host' },
    platform: 'win32'
  });
  assert.equal(spec.command, 'some-binary');
  assert.equal(spec.unsandboxed, true);
  assert.equal(spec.sandboxKind, 'none');
});

test('bwrap 真实启动（本机装了且内核允许 userns 才跑）', (t) => {
  if (process.platform !== 'linux') return t.skip('仅 Linux');
  const probe = bwrapSupported();
  if (!probe.ok) return t.skip(probe.error);
  const spec = buildMcpLaunchSpec({
    id: 'bwrap-live',
    command: 'true',
    sandbox: { mode: 'required', network: 'none' },
    platform: 'linux'
  });
  const result = spawnSync(spec.command, spec.args, { timeout: 15000, encoding: 'utf8' });
  assert.equal(result.status, 0, String(result.stderr || result.error?.message || ''));
  fs.rmSync(spec.cleanup.tempHome, { recursive: true, force: true });
});
