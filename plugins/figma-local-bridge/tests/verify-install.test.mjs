import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { verifyInstallation, runtimeVersionsCurrent } from '../scripts/verify-install.mjs';
import { verifyCodexInstallation } from '../scripts/verify-codex-install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('актуальность требует подтверждения MCP, broker и каждого подключённого плагина', () => {
  const status = { connected: true, runtime: { revision: 'current' },
    diagnostics: { sourceRevision: 'current', mcp: { revision: 'current' }, expectedPluginBuild: 'plugin' },
    files: [{ pluginBuild: 'plugin' }, { pluginBuild: 'plugin' }] };
  assert.equal(runtimeVersionsCurrent(status), true);
  for (const change of [
    value => { delete value.runtime; },
    value => { value.runtime.revision = 'old'; },
    value => { value.diagnostics.mcp.revision = 'old'; },
    value => { delete value.files[1].pluginBuild; },
    value => { value.files[1].pluginBuild = 'old'; },
    value => { delete value.diagnostics; },
    value => { value.files = []; },
    value => { value.connected = false; },
  ]) {
    const stale = structuredClone(status);
    change(stale);
    assert.equal(runtimeVersionsCurrent(stale), false);
  }
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-verify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('проверка использует отдельную ревизию broker и не доверяет ready без версий', () => {
  const status = { connected: true, runtime: { revision: 'old-full', brokerRevision: 'broker' },
    diagnostics: { sourceRevision: 'mcp', mcp: { revision: 'mcp' }, expectedBrokerRevision: 'broker', expectedPluginBuild: 'plugin' },
    files: [{ pluginBuild: 'plugin' }] };
  assert.equal(runtimeVersionsCurrent(status), true);
  status.runtime.brokerRevision = 'old-broker';
  status.diagnostics.ready = true;
  assert.equal(runtimeVersionsCurrent(status), false);
});

test('проверка действительно использует command из manifest и не подменяет его текущим Node', async t => {
  const pluginRoot = await temporary(t);
  await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'figma-local': {
    command: join(pluginRoot, 'missing-node'), args: [], cwd: '.',
  } } }));
  await assert.rejects(verifyInstallation({ pluginRoot }), /запуск MCP.*(?:ENOENT|Connection closed)/);
});

test('проверка отклоняет manifest без cwd до запуска сервера', async t => {
  const pluginRoot = await temporary(t);
  await writeFile(join(pluginRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'figma-local': {
    command: 'node', args: ['./src/server.mjs'],
  } } }));
  await assert.rejects(verifyInstallation({ pluginRoot }), /корня установленного плагина/);
});

test('проверка исходников не выдаёт проверку MCP за живое соединение с Figma', async () => {
  const report = await verifyInstallation();
  assert.equal(report.tools.length, 28);
  assert.equal(report.liveChecked, false);
  assert.equal(report.files, undefined);
});

test('проверка OpenCode запускает MCP из opencode.json и проверяет полное чтение', async () => {
  const report = await verifyInstallation({ opencode: true });
  assert.match(report.configPath, /opencode.json$/);
  assert.equal(report.tools.length, 28);
  assert.ok(report.inspectFields.includes('nodeIds'));
  assert.ok(report.inspectFields.includes('detail'));
  assert.equal(report.liveChecked, false);
});

test('проверка установленной версии обнаруживает устаревший кэш с той же версией', async t => {
  const codexHome = await temporary(t);
  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  const cached = join(codexHome, 'plugins/cache/figma-local', manifest.name, manifest.version);
  await cp(root, cached, { recursive: true, filter: path => !path.includes('node_modules') });
  await writeFile(join(cached, '.mcp.json'), '{}');
  await assert.rejects(verifyCodexInstallation({ codexHome }), /Кэш Codex устарел: .mcp.json/);
});
