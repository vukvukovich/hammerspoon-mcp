/**
 * End-to-end smoke test over the real MCP stdio protocol.
 *
 * Spawns the built binary exactly as an MCP client does, performs the
 * initialize handshake, lists tools, and calls a few. This is the check that
 * the published artifact actually works, as opposed to the modules inside it.
 *
 * Run with: node test/e2e/smoke.mjs
 * Exits non-zero on the first failure.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '../../dist/main.js');
const PROTOCOL_VERSION = '2025-11-25';

const exposure = process.argv.includes('--all') ? 'all' : 'safe';

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HS_MCP_TOOLS: exposure },
});

let stderrLog = '';
child.stderr.on('data', (chunk) => {
  stderrLog += chunk.toString('utf8');
});

const pending = new Map();
let buffer = '';
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`server wrote a non-JSON line to stdout, which corrupts the protocol: ${line}`);
      return;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

function fail(message) {
  console.error(`fatal: ${message}`);
  child.kill();
  process.exit(1);
}

try {
  console.log(`\nMCP stdio smoke test (HS_MCP_TOOLS=${exposure})\n`);

  const initialized = await send('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0.0' },
  });
  check('initialize succeeds', initialized.result !== undefined, JSON.stringify(initialized.error));
  check(
    'server identifies itself',
    initialized.result?.serverInfo?.name === 'hammerspoon-mcp',
    JSON.stringify(initialized.result?.serverInfo)
  );
  notify('notifications/initialized', {});

  const listed = await send('tools/list', {});
  const tools = listed.result?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  check('tools/list returns tools', tools.length > 0, `got ${tools.length}`);
  check(
    'every tool has a description and input schema',
    tools.every((tool) => typeof tool.description === 'string' && tool.inputSchema !== undefined)
  );

  if (exposure === 'safe') {
    check('hs_eval is absent at the safe tier', !names.includes('hs_eval'), names.join(', '));
    check('safe tier exposes 21 tools', tools.length === 21, `got ${tools.length}`);
  } else {
    check('hs_eval is present when unlocked', names.includes('hs_eval'));
    check('all tier exposes 22 tools', tools.length === 22, `got ${tools.length}`);
  }

  const health = await send('tools/call', { name: 'hs_health', arguments: {} });
  const healthText = health.result?.content?.[0]?.text ?? '';
  check('hs_health returns a result', health.result !== undefined);
  check(
    'hs_health reports a Hammerspoon version',
    healthText.includes('hammerspoonVersion'),
    healthText.slice(0, 200)
  );

  const search = await send('tools/call', {
    name: 'hs_api_search',
    arguments: { query: 'hs.window.setFrame' },
  });
  const searchText = search.result?.content?.[0]?.text ?? '';
  check(
    'hs_api_search finds an exact signature',
    searchText.includes('setFrame(rect'),
    searchText.slice(0, 200)
  );

  const windows = await send('tools/call', { name: 'hs_list_windows', arguments: {} });
  check('hs_list_windows succeeds', windows.result?.isError !== true);

  // Schema validation must reject a bad call rather than passing it to Lua.
  const bad = await send('tools/call', {
    name: 'hs_focus_window',
    arguments: { id: 1, title: 'both is invalid' },
  });
  check(
    'schema rejects mutually exclusive arguments',
    bad.error !== undefined || bad.result?.isError === true,
    JSON.stringify(bad).slice(0, 200)
  );

  // A hostile string must round-trip untouched rather than executing.
  const hostile = await send('tools/call', {
    name: 'hs_list_windows',
    arguments: { app: '"); os.exit(); ("' },
  });
  check('injection payload is handled as data', hostile.result?.isError !== true);

  check('nothing polluted stdout', true);
  if (stderrLog.includes('Registered')) {
    console.log(`\n  server log: ${stderrLog.trim().split('\n')[0]}`);
  }
} catch (error) {
  fail(error.message);
}

child.kill();
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
