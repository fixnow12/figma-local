import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('./', import.meta.url);
function digest(paths) {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(new URL(path, root))).update('\0');
  return hash.digest('hex').slice(0, 16);
}
export function sourceRevision() {
  return digest(readdirSync(root).filter(name => /\.(mjs|cjs)$/.test(name)).sort());
}
export function pluginRevision() {
  return digest(['figma-plugin/code.js', 'figma-plugin/ui.html', 'secure-channel.cjs']);
}
// Broker only loads these modules. Canvas command builders and MCP schemas are
// evaluated in the MCP process; changing them must not restart other sessions.
export function brokerRevision() {
  return digest(['operation-journal.mjs', 'mutation-reconciliation.mjs', 'component-dry-run-recovery.mjs', 'bridge-errors.mjs', 'bridge.mjs', 'broker.mjs', 'installation.mjs', 'runtime-info.mjs', 'secure-channel.cjs']);
}
// Snapshot at process start: reading only the files on disk would hide a stale process.
export const runtimeInfo = { revision: sourceRevision(), brokerRevision: brokerRevision(), startedAt: new Date().toISOString() };

export function runtimeDiagnostics(status, { fileKey } = {}) {
  const revision = sourceRevision();
  const expectedPlugin = pluginRevision();
  const expectedBroker = brokerRevision();
  const issues = [];
  const files = (status.files || []).filter(file => !fileKey || file.fileKey === fileKey);
  const current = {
    mcp: runtimeInfo.revision === revision,
    broker: status.runtime?.brokerRevision ? status.runtime.brokerRevision === expectedBroker : status.runtime?.revision === revision,
    plugin: files.length > 0 && files.every(file => file.pluginBuild === expectedPlugin),
  };
  if (!current.mcp) issues.push({ code: 'MCP_OUTDATED', action: 'reconnect_mcp', message: 'Исходники MCP обновлены после его запуска. Переподключите figma-local в OpenCode и откройте новый чат для обновления каталога инструментов.' });
  if (!current.broker) issues.push({ code: 'BROKER_OUTDATED', action: status.maintenance?.state === 'deferred' ? 'wait_for_operations' : 'restart_broker', message: 'Broker устарел или не сообщает актуальную ревизию. Обновление откладывается до завершения операций; старым версиям нужен однократный перезапуск broker и MCP.' });
  for (const file of files) {
    if (file.pluginBuild !== expectedPlugin) issues.push({ code: 'PLUGIN_OUTDATED', action: 'reopen_plugin', fileKey: file.fileKey, message: `Плагин в файле ${file.fileName} не подтверждает актуальную сборку. Обновите персональную сборку установщиком и заново откройте Bridge в этом файле.` });
  }
  for (const execution of status.execution || []) {
    if (fileKey && execution.fileKey !== fileKey) continue;
    if (execution.code === 'PLUGIN_OUTDATED') continue; // Version issue already identifies the required update.
    if (!execution.responsive) issues.push({ code: 'PLUGIN_UNRESPONSIVE', action: 'check_target_plugin', fileKey: execution.fileKey,
      message: 'Plugin API целевого файла не ответил на проверку готовности. Проверьте окно Bridge в этом файле; соединение WebSocket не доказывает готовность.' });
    else if (execution.busy) issues.push({ code: 'PLUGIN_BUSY', action: 'wait_for_operation', fileKey: execution.fileKey,
      activeOperation: execution.activeOperation,
      message: 'Plugin API этого файла ещё выполняет команду. Не повторяйте запросы циклом с sleep. После тайм-аута записи сначала проверьте её результат.' });
  }
  const ready = Boolean(status.connected && current.mcp && current.broker && current.plugin && !issues.length);
  const state = issues[0]?.code || (ready ? 'READY' : 'FILE_NOT_CONNECTED');
  const nextAction = issues[0]?.action || (ready ? 'continue' : 'open_figma_plugin');
  return { ready, state, nextAction, current, issues, mcp: runtimeInfo, sourceRevision: revision,
    capabilities: ready && fileKey && status.execution?.some(item => item.fileKey === fileKey && item.responsive === true && !item.busy) ? [...(status.operationJournal === true ? ["operation-journal-v1", "mutation-receipts-v1", "mutation-reconciliation-v1", "render-target-parent-v1"] : []), "text-lists-v1", "glass-effects-v1", "vector-properties-v1", "text-range-variables-v1", "navigate-scroll-default-v1", "instance-scale-v1", "node-variable-modes-v1", "nested-component-swaps-v1", "component-set-import-v1", "page-transfer-v1"] : [],
    capabilityFileKey: fileKey || null,
    expectedBrokerRevision: expectedBroker, expectedPluginBuild: expectedPlugin, warnings: issues.map(issue => issue.message),
    activityNote: 'isActive — последнее событие файла, а не проверка активной вкладки или готовности Plugin API.' };
}
