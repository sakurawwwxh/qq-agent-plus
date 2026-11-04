// 测试用 MCP server：只实现 initialize / tools/list / tools/call。
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

rl.on('line', (line) => {
  let message = null;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1' } } });
    return;
  }
  if (message?.method === 'notifications/initialized') return;
  if (message?.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: '原样返回传入的 text',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
          },
          ...(process.env.MCP_FAKE_OVERSIZED === '1' ? [{
            name: 'oversized',
            description: '故意超过 schema 上限',
            inputSchema: {
              type: 'object',
              properties: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`p${i}`, { type: 'string', description: 'x'.repeat(200) + i }]))
            }
          }] : [])
        ]
      }
    });
    return;
  }
  if (message?.method === 'tools/call') {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    if (name !== 'echo') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown tool ${name}` } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] } });
    return;
  }
  if (message?.id != null) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
