import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function runtimeVersionsCurrent(status) {
  const diagnostics = status.diagnostics;
  const revision = diagnostics?.sourceRevision;
  const pluginBuild = diagnostics?.expectedPluginBuild;
  const brokerCurrent = diagnostics?.expectedBrokerRevision && status.runtime?.brokerRevision
    ? status.runtime.brokerRevision === diagnostics.expectedBrokerRevision
    : status.runtime?.revision === revision;
  return Boolean(status.connected && revision && pluginBuild &&
    diagnostics.mcp?.revision === revision && brokerCurrent &&
    status.files?.length && status.files.every(file => file.pluginBuild === pluginBuild));
}

export async function verifyInstallation({ pluginRoot = sourceRoot, opencode = false, live = false, screenshot = false, requireCurrent = false, env = process.env } = {}) {
pluginRoot = resolve(pluginRoot);
const configPath = opencode ? resolve(pluginRoot, '../../opencode.json') : resolve(pluginRoot, '.mcp.json');
const manifest = JSON.parse(await readFile(configPath, 'utf8'));
let config = manifest.mcpServers?.['figma-local'];
if (opencode) {
  const entry = manifest.mcp?.['figma-local'];
  assert.equal(entry?.type, 'local', 'OpenCode: figma-local должен быть локальным MCP');
  assert.notEqual(entry.enabled, false, 'OpenCode: figma-local отключён');
  assert.ok(Array.isArray(entry.command) && entry.command.length, 'OpenCode: не задана команда MCP');
  config = { command: entry.command[0], args: entry.command.slice(1), cwd: entry.cwd || '.', env: entry.environment };
}
// Codex otherwise inherits the task directory, not the installed plugin directory.
if (!opencode) assert.equal(config.cwd, '.', 'MCP должен запускаться из корня установленного плагина');
const serverCwd = resolve(dirname(configPath), config.cwd);
const expectedTools = ['activate_page', 'assemble_library_template', 'bind_variables', 'capture_library_template', 'clone_nodes', 'export_assets', 'find_assets', 'get_file_metadata', 'get_operation_status', 'get_page_settings', 'get_status', 'import_variables', 'inspect_selection', 'move_nodes', 'patch_nodes', 'read_catalog_example', 'read_catalog_inventory', 'recreate_screen', 'render_screen', 'resolve_resource_keys', 'resolve_variables', 'scan_catalog_page', 'set_file_metadata', 'set_node_variable_modes', 'set_page_settings', 'set_reactions', 'set_text_links', 'use_component'];

const transport = new StdioClientTransport({
  // Do not substitute process.execPath: that hides a broken command/PATH.
  command: config.command,
  args: config.args,
  cwd: serverCwd,
  env: { ...env, ...config.env },
  stderr: 'pipe'
});
const client = new Client({ name: 'figma-local-verifier', version: '1.0.0' });
// Drain diagnostics without exposing pairing references or private data.
transport.stderr?.on('data', () => {});
let stage = `запуск MCP из ${opencode ? 'opencode.json' : '.mcp.json'}`;

try {
  await client.connect(transport, { timeout: 10000 });
  stage = 'список инструментов MCP';
  const response = await client.listTools();
  const actualTools = response.tools.map((tool) => tool.name).sort();
  assert.deepEqual(actualTools, [...expectedTools].sort());
  const inspect = response.tools.find(tool => tool.name === 'inspect_selection').inputSchema.properties;
  assert.equal(inspect.nodeIds?.type, 'array', 'Устаревшая схема inspect_selection: нет nodeIds');
  assert.deepEqual(inspect.detail?.enum, ['compact', 'full'], 'Устаревшая схема inspect_selection: нет detail');
  assert.equal(inspect.depth?.maximum, 8);
  assert.equal(inspect.maxNodes?.maximum, 1000);
  for (const tool of response.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name}: слишком короткое описание`);
    assert.equal(tool.inputSchema.type, 'object');
    function checkArrays(schema, path = tool.name) {
      if (!schema || typeof schema !== 'object') return;
      assert.ok(!Array.isArray(schema.items), `${path}: tuple items несовместимы с MCP-клиентом`);
      for (const [key, value] of Object.entries(schema)) checkArrays(value, `${path}.${key}`);
    }
    checkArrays(tool.inputSchema);
  }
  const renderNode = response.tools.find(tool => tool.name === 'render_screen').inputSchema.properties.spec.properties.nodes.items.properties;
  const modes = response.tools.find(tool => tool.name === 'set_node_variable_modes');
  assert.equal(modes.inputSchema.properties.bindings.maxItems, 40);
  assert.ok(modes.inputSchema.required.includes('fileKey'));
  const bindings = response.tools.find(tool => tool.name === 'bind_variables').inputSchema.properties.bindings.items.properties;
  const patch = response.tools.find(tool => tool.name === 'patch_nodes').inputSchema.properties.patches.items.properties.set.properties;
  for (const field of ['listOptions', 'listSpacing', 'indentation', 'vectorPaths', 'booleanOperation', 'pointCount']) assert.ok(renderNode[field] && patch[field], `Устаревшая fidelity-v2 схема: ${field}`);
  assert.ok(renderNode.effects.items.properties.type.enum.includes('GLASS'), 'Устаревшая схема эффектов: нет GLASS');
  for (const field of ['fontFamily', 'fontWeight', 'lineHeight', 'fills']) assert.ok(bindings.field.enum.includes(field), `Нет привязки ${field}`);
  assert.equal(patch.scaleFactor.type, 'number');
  assert.equal(bindings.start.type, 'integer'); assert.equal(bindings.end.type, 'integer');
  const report = { pluginRoot, configPath, command: config.command, tools: actualTools,
    inspectFields: Object.keys(inspect), liveChecked: false,
    note: 'Проверен новый MCP-процесс из конфигурации. Каталог уже открытого чата может быть устаревшим: переподключите MCP и откройте новый чат.' };
  if (!live && !screenshot && !requireCurrent) return report;
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    const payload = response.structuredContent || JSON.parse(response.content.find(item => item.type === 'text').text);
    if (response.isError) throw new Error(payload.error || `${name}: MCP error`);
    return { payload, content: response.content };
  }
  stage = 'подключение Bridge к Figma';
  const { payload: status } = await call('get_status');
  assert.ok(status.connected && status.files?.length, 'MCP работает, но файл Figma не подключён. Откройте Bridge — Auto в целевом файле.');
  report.diagnostics = status.diagnostics || null;
  report.runtimeCurrent = runtimeVersionsCurrent(status);
  if (requireCurrent) {
    stage = 'актуальность работающих MCP, broker и плагина Figma';
    assert.ok(report.runtimeCurrent, status.diagnostics?.warnings?.join(' ') ||
      'Работающие процессы не подтверждают текущие ревизии. Обновите установку и перезапустите Bridge и MCP после завершения операций.');
  }
  report.files = [];
  for (const file of status.files) {
    stage = `чтение Figma (${file.fileName || file.fileKey})`;
    const { payload } = await call('inspect_selection', { fileKey: file.fileKey, detail: 'full', depth: 1, maxNodes: 30 });
    const selection = payload.result?.selection;
    assert.ok(Array.isArray(selection), 'MCP не вернул выделение');
    const entry = { fileKey: file.fileKey, fileName: file.fileName, selection: selection.map(node => ({ id: node.id, name: node.name, type: node.type })) };
    if (screenshot && selection.length) {
      stage = `PNG Figma (${file.fileName || file.fileKey})`;
      const result = await call('inspect_selection', { fileKey: file.fileKey, nodeId: selection[0].id, depth: 0, maxNodes: 1, screenshot: true, screenshotScale: 0.5 });
      assert.equal(result.payload.screenshot?.status, 'captured', result.payload.screenshot?.error || 'PNG не получен');
      const png = result.content.find(item => item.type === 'image' && item.mimeType === 'image/png');
      assert.ok(png?.data, 'В ответе нет изображения PNG');
      entry.screenshotBytes = Buffer.from(png.data, 'base64').length;
    }
    report.files.push(entry);
  }
  if (screenshot) assert.ok(report.files.some(file => file.screenshotBytes > 0), 'Для проверки PNG выделите узел хотя бы в одном подключённом файле');
  report.liveChecked = true;
  return report;
} catch (error) {
  throw new Error(`Проверка не пройдена — ${stage}: ${error.message}`, { cause: error });
} finally {
  await client.close();
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'plugin-root': { type: 'string' }, opencode: { type: 'boolean' }, live: { type: 'boolean' }, screenshot: { type: 'boolean' }, 'require-current': { type: 'boolean' } } });
    const report = await verifyInstallation({ pluginRoot: values['plugin-root'], opencode: values.opencode, live: values.live, screenshot: values.screenshot, requireCurrent: values['require-current'] });
    console.log(JSON.stringify(report, null, 2));
    if (!report.liveChecked) console.log('MCP-контракт проверен. Соединение с Figma не проверялось; для этого запустите verify -- --live --screenshot.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
