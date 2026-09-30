import test from "node:test";
import assert from "node:assert/strict";
import { runToolOperation, toolFailure } from "../src/tool-results.mjs";
import { parseRenderScreenInput } from "../src/schemas.mjs";
import { readFile } from 'node:fs/promises';
import { FigmaBridge } from '../src/bridge.mjs';

test('внешний MCP бюджет покрывает запись и снимок с проверками подключения', async () => {
  const config = JSON.parse(await readFile(new URL('../../../opencode.json', import.meta.url), 'utf8'));
  const timeouts = [];
  const bridge = new FigmaBridge();
  bridge.waitForConnection = async () => {};
  bridge.wsServer = {
    getConnectedFiles: () => [{ fileKey: 'guide' }],
    sendCommand: async (_method, _params, timeout) => {
      timeouts.push(timeout);
      return { success: true, result: { rootId: '1:2' }, image: { base64: 'AA==' } };
    },
  };
  // Largest supported execution, followed by a preview, are sequential phases.
  await bridge.execute('return 1', { fileKey: 'guide', timeout: 60000 });
  await bridge.captureScreenshot('1:2', { fileKey: 'guide' });
  assert.ok(timeouts[1] > 30000 + 2000, 'снимок должен пережить экспорт и probe готовности');
  const startupBudget = 6000 + 5000 + 5000; // discovery, status, plugin startup grace
  const perPhaseRoutingBudget = 10000 + 5000; // connection resolution and file queue
  assert.ok(config.mcp['figma-local'].timeout >= startupBudget + 2 * perPhaseRoutingBudget + timeouts[0] + timeouts[1],
    'клиент должен получить applied/unknown и результат снимка прежде собственного тайм-аута');
});

test("ошибки схемы возвращают читаемые пути полей без вложенного экранированного JSON", () => {
  let error;
  try {
    parseRenderScreenInput({ spec: { key: "screen", name: "Экран", type: "screen", width: 320, height: 240,
      nodes: Array.from({ length: 30 }, (_, i) => ({ type: "text", key: `text-${i}`, name: "Текст", content: "А", lineHeight: "28px" })),
    } });
  } catch (caught) { error = caught; }
  assert.ok(error);
  const result = toolFailure(error);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, result.structuredContent.error);
  assert.match(result.content[0].text, /spec\.nodes\[0\]\.lineHeight/);
  assert.match(result.content[0].text, /Ещё полей с ошибками: 18/);
  assert.equal(result.content[0].text.includes("unionErrors"), false);
  assert.equal(result.content[0].text.includes('\\n'), false);
  assert.equal(result.structuredContent.operationStatus, 'not_applied');
  assert.equal(result.structuredContent.code, 'INVALID_ARGUMENTS');
  assert.match(result.structuredContent.nextStep, /исправ/i);
});

test("ошибка снимка не превращает успешную запись в ошибку инструмента", async () => {
  let writes = 0;
  const target = { fileKey: "file-a", pageId: "page-a" };
  const bridge = {
    runInFile: async (_key, operation) => operation(target),
    execute: async (_code, options) => { writes++; assert.equal(options.fileKey, "file-a"); return { result: { rootId: "1:2" } }; },
    captureScreenshot: async (_id, options) => { assert.equal(options.fileKey, "file-a"); throw new Error("Экспорт не удался"); },
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true, screenshotNode: (payload) => payload.result.rootId });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.operationStatus, "applied");
  assert.equal(response.structuredContent.screenshot.status, "failed");
  assert.equal(writes, 1);
  assert.deepEqual(response.structuredContent.timings.stages.map(({ name, status }) => [name, status]),
    [['resolveTarget', 'ok'], ['execute', 'ok'], ['screenshot', 'error']]);
});

test('ошибка готовности сохраняет следующий шаг в MCP-ответе', () => {
  const response = toolFailure(Object.assign(new Error('Плагин не отвечает'), {
    code: 'PLUGIN_UNRESPONSIVE', operationStatus: 'not_applied', nextStep: 'Откройте целевой файл',
    retryPolicy: 'after_state_change',
  }));
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.code, 'PLUGIN_UNRESPONSIVE');
  assert.equal(response.structuredContent.nextStep, 'Откройте целевой файл');
  assert.equal(response.structuredContent.retryPolicy, 'after_state_change');
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
});

test('catalog phase snapshot survives remote error and MCP error envelope',async()=>{
  const {remoteError}=await import('../src/bridge-errors.mjs');
  const catalogDiagnostics={phase:'fullTree',lastStartedPhase:'fullTree',elapsedMs:30,phaseElapsedMs:12,
    timings:{pageLookupMs:2,pageLoadMs:16,fullTreeMs:12},counts:{pageNodesVisited:2048}};
  const error=remoteError('Execution timed out',{code:'PLUGIN_EXECUTION_TIMEOUT',operationStatus:'unknown',catalogDiagnostics});
  const result=toolFailure(error);
  assert.equal(result.structuredContent.code,'PLUGIN_EXECUTION_TIMEOUT');
  assert.deepEqual(result.structuredContent.catalogDiagnostics,catalogDiagnostics);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
});

test("ошибка записи сохраняет статус отката и не запускает экспорт", async () => {
  const bridge = {
    runInFile: async (_key, operation) => operation({ fileKey: "a" }),
    execute: async () => { throw Object.assign(new Error("Ошибка"), { operationStatus: "partial", rollbackErrors: ["Не восстановлен узел"] }); },
    captureScreenshot: async () => assert.fail("Экспорт после неудачной записи"),
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.operationStatus, "partial");
  assert.deepEqual(response.structuredContent.rollbackErrors, ["Не восстановлен узел"]);
  assert.deepEqual(response.structuredContent.timings.stages.map(({ name, status }) => [name, status]),
    [['resolveTarget', 'ok'], ['execute', 'error']]);
});

test("PNG и одинаковые метаданные доступны в обоих форматах ответа", async () => {
  const bridge = {
    runInFile: async (_key, operation) => operation({ fileKey: "a" }),
    execute: async () => ({ result: { id: "1" } }),
    captureScreenshot: async () => ({ base64: "AA==", format: "PNG", scale: 1, byteLength: 1 }),
  };
  const response = await runToolOperation(bridge, {}, "code", { screenshotRequested: true, screenshotNode: (payload) => payload.result.id });
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  assert.equal(response.content[1].type, "image");
  assert.equal(response.structuredContent.screenshot.base64, undefined);
  const timings = response.structuredContent.timings;
  assert.equal(timings.version, 1);
  assert.equal(timings.scope, 'bridge_operation');
  assert.deepEqual(timings.stages.map(stage => stage.name), ['resolveTarget', 'execute', 'screenshot']);
  assert.ok(timings.totalMs >= 0);
  for (const stage of timings.stages) {
    assert.ok(Number.isFinite(stage.durationMs) && stage.durationMs >= 0);
    assert.ok(stage.durationMs <= timings.totalMs);
    assert.equal(stage.status, 'ok');
  }
});

test('замер ошибки подключения сохраняет unknown и не отправляет команду', async () => {
  const bridge = {
    runInFile: async () => { throw Object.assign(new Error('Нет соединения'), { operationStatus: 'unknown' }); },
    execute: () => assert.fail('Команда не должна отправляться'),
  };
  const response = await runToolOperation(bridge, {}, 'code', { operationName: 'patch_nodes' });
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent.operationStatus, 'unknown');
  assert.equal(response.structuredContent.timings.operation, 'patch_nodes');
  assert.deepEqual(response.structuredContent.timings.stages.map(({ name, status }) => [name, status]),
    [['resolveTarget', 'error']]);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
});
