// 官方 MCP Registry 导入：包类型映射、版本去重、非 stdio 标记。
import assert from 'node:assert/strict';
import { it } from 'node:test';

const { mapRegistryEntry, searchRegistry } = await import('../src/mcp/registry.js');
const { MCP_PRESETS, searchPresets } = await import('../src/mcp/presets.js');

const npmEntry = {
  name: 'io.github.demo/filesystem',
  title: 'Demo FS',
  version: '1.2.3',
  description: 'demo',
  repository: { url: 'https://github.com/demo/fs' },
  packages: [{
    registryType: 'npm',
    identifier: '@demo/fs',
    version: '1.2.3',
    runtimeHint: 'npx',
    transport: { type: 'stdio' },
    runtimeArguments: [{ value: '-y', type: 'positional' }],
    environmentVariables: [{ name: 'ROOT' }, { name: 'TOKEN', isSecret: true }]
  }]
};

it('npm stdio 包映射成 npx 命令，环境变量留空占位', () => {
  const mapped = mapRegistryEntry(npmEntry);
  assert.equal(mapped.unsupported, false);
  assert.equal(mapped.config.command, 'npx');
  assert.deepEqual(mapped.config.args, ['-y', '@demo/fs@1.2.3']);
  assert.deepEqual(mapped.config.env, { ROOT: '', TOKEN: '' });
  assert.equal(mapped.config.id, 'io_github_demo_filesystem');
});

it('oci 包映射成 docker run', () => {
  const mapped = mapRegistryEntry({
    ...npmEntry,
    packages: [{ registryType: 'oci', identifier: 'demo/fs:1', transport: { type: 'stdio' } }]
  });
  assert.equal(mapped.config.command, 'docker');
  assert.deepEqual(mapped.config.args, ['run', '-i', '--rm', 'demo/fs:1']);
});

it('registry 的 runtimeArguments 不能换包，env 不能覆盖启动器变量', () => {
  const mapped = mapRegistryEntry({
    ...npmEntry,
    packages: [{
      ...npmEntry.packages[0],
      runtimeArguments: [
        { value: '-y' },
        { value: '--package=evil' },
        { value: '--call' },
        { value: 'evil-pkg' },
        { value: 'sh -c id' }
      ],
      environmentVariables: [
        { name: 'SAFE_TOKEN', default: 'x' },
        { name: 'PATH', default: '/tmp/evil' },
        { name: 'NODE_OPTIONS', default: '--require=/tmp/evil.js' },
        { name: 'NODE_PATH', default: '/tmp/evil' },
        { name: 'UV_INDEX_URL', default: 'https://evil.invalid' },
        { name: 'HTTPS_PROXY', default: 'http://evil.invalid:8080' },
        { name: 'ALL_PROXY', default: 'socks5://evil.invalid:1080' },
        { name: 'NODE_TLS_REJECT_UNAUTHORIZED', default: '0' },
        { name: 'NODE_EXTRA_CA_CERTS', default: '/tmp/evil.pem' },
        { name: 'BAD-NAME', default: 'x' }
      ]
    }]
  });
  assert.deepEqual(mapped.config.args, ['-y', '@demo/fs@1.2.3', 'evil-pkg', 'sh -c id']);
  assert.deepEqual(mapped.config.env, { SAFE_TOKEN: 'x' });
});

it('没有版本的 npm 包拒绝导入（避免 npx 执行 latest）', () => {
  const mapped = mapRegistryEntry({
    ...npmEntry,
    version: '',
    packages: [{ ...npmEntry.packages[0], version: '' }]
  });
  assert.equal(mapped, null);
});

it('npm identifier/version 不能变成 npx 选项或范围', () => {
  for (const identifier of ['--package=evil', '-c', 'foo bar', 'foo@1.0.0', '../evil', 'https://evil.invalid/pkg']) {
    const mapped = mapRegistryEntry({
      ...npmEntry,
      packages: [{ ...npmEntry.packages[0], identifier }]
    });
    assert.equal(mapped, null, identifier);
  }
  for (const version of ['1.0.0 --package=evil', '-1.0.0', '^1.0.0', 'latest', '1.0', '1.0.0 || 2.0.0']) {
    const mapped = mapRegistryEntry({
      ...npmEntry,
      version,
      packages: [{ ...npmEntry.packages[0], version }]
    });
    assert.equal(mapped, null, version);
  }
  const okay = mapRegistryEntry({
    ...npmEntry,
    version: '1.2.3-rc.1',
    packages: [{ ...npmEntry.packages[0], version: '1.2.3-rc.1' }]
  });
  assert.equal(okay.config.args[1], '@demo/fs@1.2.3-rc.1');
});

it('oci 包的 env 交给 docker -e，不污染启动器', () => {
  const mapped = mapRegistryEntry({
    ...npmEntry,
    packages: [{
      registryType: 'oci', identifier: 'demo/fs:1', transport: { type: 'stdio' },
      environmentVariables: [{ name: 'TOKEN', default: 'secret' }]
    }]
  });
  assert.deepEqual(mapped.config.args, ['run', '-i', '--rm', '-e', 'TOKEN=secret', 'demo/fs:1']);
  assert.deepEqual(mapped.config.env, {});
});

it('oci 没有 tag/digest 时用 version 钉住；没有版本或引用以 - 开头就拒绝', () => {
  const pinned = mapRegistryEntry({
    ...npmEntry,
    packages: [{ registryType: 'oci', identifier: 'demo/fs', transport: { type: 'stdio' } }]
  });
  assert.deepEqual(pinned.config.args, ['run', '-i', '--rm', 'demo/fs:1.2.3']);

  const unpinned = mapRegistryEntry({
    ...npmEntry,
    version: '',
    packages: [{ registryType: 'oci', identifier: 'demo/fs', transport: { type: 'stdio' } }]
  });
  assert.equal(unpinned, null, '没有 tag 也没有版本时必须拒绝，不能跑 latest');
  const option = mapRegistryEntry({
    ...npmEntry,
    packages: [{ registryType: 'oci', identifier: '--privileged', transport: { type: 'stdio' } }]
  });
  assert.equal(option, null, 'docker 位置参数不能是选项');
});

it('registry 的 runtimeHint 不能变成任意命令：只允许 npx，其余回落 npx', () => {
  for (const runtimeHint of ['/tmp/evil', '../../evil', 'powershell', 'bash', 'curl', 'uvx', 'node', 'python', 'docker', 'bunx']) {
    const mapped = mapRegistryEntry({
      ...npmEntry,
      packages: [{ ...npmEntry.packages[0], runtimeHint }]
    });
    assert.equal(mapped.config.command, 'npx', runtimeHint);
  }
  const allowed = mapRegistryEntry({
    ...npmEntry,
    packages: [{ ...npmEntry.packages[0], runtimeHint: '/usr/local/bin/npx' }]
  });
  assert.equal(allowed.config.command, 'npx', '允许的运行器只保留 basename');
});

it('只有远程 HTTP 的 server 标记为不支持 stdio', () => {
  const mapped = mapRegistryEntry({
    name: 'remote/demo',
    remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }]
  });
  assert.equal(mapped.unsupported, true);
  assert.match(mapped.reason, /stdio/);
});

it('内置预设离线可用，按关键词过滤', () => {
  assert.ok(MCP_PRESETS.length >= 5);
  for (const item of MCP_PRESETS) {
    assert.ok(item.config.command);
    assert.ok(Array.isArray(item.config.args));
  }
  assert.ok(searchPresets('git').some((item) => item.id === 'git'));
  assert.ok(searchPresets('github').some((item) => item.id === 'github'));
  assert.equal(searchPresets('no-such-server').length, 0);
});

it('空查询走“最近更新”列表（不带 search 参数）', async () => {
  let calledUrl = '';
  const fetchImpl = async (url) => {
    calledUrl = url;
    return { statusCode: 200, body: JSON.stringify([npmEntry]) };
  };
  const results = await searchRegistry('', { fetchImpl });
  assert.match(calledUrl, /\?limit=/);
  assert.doesNotMatch(calledUrl, /search=/);
  assert.equal(results.length, 1);
});

it('同名多版本只保留最高版本；兼容数组/对象两种响应', async () => {
  const fetchImpl = async () => ({
    statusCode: 200,
    body: JSON.stringify([
      { ...npmEntry, version: '1.0.0', packages: [{ ...npmEntry.packages[0], version: '1.0.0' }] },
      { ...npmEntry, version: '1.10.0', packages: [{ ...npmEntry.packages[0], version: '1.10.0' }] }
    ])
  });
  const results = await searchRegistry('filesystem', { fetchImpl });
  assert.equal(results.length, 1);
  assert.equal(results[0].version, '1.10.0');
  assert.match(results[0].config.args.at(-1), /@1\.10\.0$/);
});
