import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeDiagnostics, runtimeInfo, pluginRevision } from '../src/runtime-info.mjs';

test('READY учитывает живую занятость выбранного Plugin API и сохраняет fileKey причины', () => {
  const status = { connected: true, runtime: runtimeInfo, files: [
    { fileKey: 'ready', fileName: 'Макет', pluginBuild: pluginRevision() },
    { fileKey: 'busy', fileName: 'Библиотека', pluginBuild: pluginRevision() },
  ], execution: [
    { fileKey: 'ready', responsive: true, busy: false },
    { fileKey: 'busy', responsive: true, busy: true, activeOperation: { name: 'find_assets', mutating: false, elapsedMs: 60000 } },
  ] };
  assert.equal(runtimeDiagnostics(status, { fileKey: 'ready' }).ready, true);
  assert.ok(runtimeDiagnostics(status, { fileKey: 'ready' }).capabilities.includes('node-variable-modes-v1'));
  assert.deepEqual(runtimeDiagnostics(status, { fileKey: 'busy' }).capabilities, []);
  assert.deepEqual(runtimeDiagnostics(status).capabilities, []);
  const diagnosis = runtimeDiagnostics(status, { fileKey: 'busy' });
  assert.equal(diagnosis.ready, false);
  assert.equal(diagnosis.state, 'PLUGIN_BUSY');
  assert.equal(diagnosis.issues[0].fileKey, 'busy');
  assert.equal(diagnosis.issues[0].activeOperation.name, 'find_assets');
  status.execution[1] = { fileKey: 'busy', responsive: false };
  assert.equal(runtimeDiagnostics(status, { fileKey: 'busy' }).state, 'PLUGIN_UNRESPONSIVE');
});

test('старый плагин без нового probe не объявляется неотвечающим Plugin API', () => {
  const status = { connected: true, runtime: runtimeInfo,
    files: [{ fileKey: 'old', fileName: 'Макет', pluginBuild: 'old-build' }],
    execution: [{ fileKey: 'old', responsive: null, code: 'PLUGIN_OUTDATED' }] };
  const diagnosis = runtimeDiagnostics(status, { fileKey: 'old' });
  assert.equal(diagnosis.ready, false);
  assert.deepEqual(diagnosis.issues.map(issue => issue.code), ['PLUGIN_OUTDATED']);
});

test('готовность выбранного файла не зависит от старого плагина другого файла', () => {
  const status = { connected: true, runtime: runtimeInfo, files: [
    { fileKey: 'current', fileName: 'Рабочий', pluginBuild: pluginRevision() },
    { fileKey: 'old', fileName: 'Другой', pluginBuild: 'old-build' },
  ] };
  assert.equal(runtimeDiagnostics(status).ready, false);
  const current = runtimeDiagnostics(status, { fileKey: 'current' });
  assert.equal(current.ready, true);
  assert.equal(current.state, 'READY');
  assert.deepEqual(current.issues, []);
  assert.equal(runtimeDiagnostics(status, { fileKey: 'old' }).ready, false);
  assert.equal(runtimeDiagnostics(status, { fileKey: 'absent' }).ready, false);
});

test('обновление файлов на диске не маскирует ревизию уже работающего процесса', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'figma-plugin'));
  await copyFile(new URL('../src/runtime-info.mjs', import.meta.url), join(directory, 'runtime-info.mjs'));
  for (const file of ['operation-journal.mjs', 'mutation-reconciliation.mjs', 'component-dry-run-recovery.mjs', 'schemas.mjs', 'broker.mjs', 'bridge.mjs', 'bridge-errors.mjs', 'installation.mjs', 'secure-channel.cjs', 'figma-plugin/code.js', 'figma-plugin/ui.html']) {
    await writeFile(join(directory, file), 'old');
  }
  const runtime = await import(pathToFileURL(join(directory, 'runtime-info.mjs')));
  const status = { connected: true, runtime: runtime.runtimeInfo, files: [{ fileName: 'Макет', pluginBuild: runtime.pluginRevision() }] };
  assert.deepEqual(runtime.runtimeDiagnostics(status).warnings, []);
  assert.equal(runtime.runtimeDiagnostics(status).ready, true);
  const brokerRevision = runtime.brokerRevision();
  await writeFile(join(directory, 'schemas.mjs'), 'new schema');
  await writeFile(join(directory, 'figma-plugin/code.js'), 'new plugin');
  const diagnosis = runtime.runtimeDiagnostics(status);
  assert.notEqual(diagnosis.mcp.revision, diagnosis.sourceRevision);
  assert.ok(diagnosis.warnings.some(message => message.includes('каталога инструментов')));
  assert.equal(runtime.brokerRevision(), brokerRevision, 'схемы и код плагина не меняют broker');
  assert.equal(diagnosis.current.broker, true);
  assert.equal(diagnosis.ready, false);
  assert.ok(diagnosis.warnings.some(message => message.includes('Макет')));
  await writeFile(join(directory, 'bridge.mjs'), 'new transport');
  assert.notEqual(runtime.brokerRevision(), brokerRevision);
  assert.equal(runtime.runtimeDiagnostics(status).current.broker, false);
  assert.ok(runtime.runtimeDiagnostics(status).issues.some(issue => issue.code === 'BROKER_OUTDATED'));
});
