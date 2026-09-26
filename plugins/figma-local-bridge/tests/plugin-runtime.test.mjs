import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import vm from 'node:vm';
import { prepareInstallation } from '../scripts/prepare-install.mjs';
import { startBroker } from '../src/broker.mjs';
import { BrokerClient } from '../src/broker-client.mjs';

test('полный установленный UI: auto auth → FILE_INFO → команда → Pause → Resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await prepareInstallation(directory);
  const broker = await startBroker({ directory, port: 0 });
  t.after(() => broker.stop());
  let html = await readFile(join(directory, 'figma-plugin/ui.html'), 'utf8');
  // Only the test listener port differs; execute every generated script verbatim.
  html = html.replace('var WS_PORT_RANGE_START = 9233;', `var WS_PORT_RANGE_START = ${broker.bridge.port};`).replace('var WS_PORT_RANGE_END = 9233;', `var WS_PORT_RANGE_END = ${broker.bridge.port};`);
  const timers = new Set(), sockets = [], commands = [], errors = [];
  let busy = false, responsive = true, executionFailure, journalCommand;
  let clockOffset = 0;
  const context = {
    TextEncoder, TextDecoder, Uint8Array, DataView, AbortSignal,
    Date: class extends Date { static now() { return Date.now() + clockOffset; } },
    crypto: { getRandomValues: array => webcrypto.getRandomValues(array) },
    console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    document: { getElementById: () => null, querySelector: () => null, body: { setAttribute() {} }, documentElement: { classList: { contains: () => false } } },
    addEventListener() {},
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, clearInterval,
    setInterval(fn, ms) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
    requestAnimationFrame(fn) { const timer = setTimeout(fn, 0); timers.add(timer); },
    fetch,
    WebSocket: class extends WebSocket { constructor(url) { super(url.replace('localhost', '127.0.0.1')); sockets.push(this); } },
    parent: { postMessage({ pluginMessage: message }) {
      if (message.type === 'RESIZE_UI') return;
      commands.push(message.type);
      if (message.type === 'GET_EXECUTION_STATUS' && !responsive) return;
      if (message.type === 'EXECUTE_CODE' && message.operation?.journal) {journalCommand=message;return;}
      const response = { requestId: message.requestId, type: `${message.type}_RESULT`, success: true };
      if (message.type === 'GET_FILE_INFO') response.fileInfo = { fileKey: 'ui-file', fileName: 'Runtime test', pluginVersion: '0.3.0' };
      else if (message.type === 'GET_EXECUTION_STATUS') Object.assign(response, { busy, pendingExecutions: busy ? 1 : 0,
        activeOperation: busy ? { name: 'find_assets', mutating: false, elapsedMs: 50000 } : null });
      else if (message.type === 'EXECUTE_CODE') {
        if (executionFailure) Object.assign(response, { success: false, error: 'Шрифт недоступен' }, executionFailure);
        else { response.result = { marker: 'executed' }; response.fileContext = { fileKey: 'ui-file' }; }
      }
      queueMicrotask(() => context.onmessage({ data: { pluginMessage: response } }));
    } },
  };
  context.window = context; context.self = context;
  vm.createContext(context);
  t.after(() => { context.__wsDisconnectAll?.(); for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.terminate(); });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error(`UI timeout: ${JSON.stringify(errors)}`);
  }
  await waitFor(() => broker.bridge.status().connected);
  assert.equal(context.__wsGetAuthenticatedCount(), 1);
  const client = new BrokerClient({ directory, ports: [broker.bridge.port], autoStart: false }); t.after(() => client.stop());
  assert.deepEqual((await client.execute('return 1')).result, { marker: 'executed' });
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 1);
  assert.match((await client.status()).files[0].pluginBuild, /^[a-f0-9]{16}$/);
  busy = true;
  const executing = await client.executionStatus('ui-file');
  assert.equal(executing.responsive, true);
  assert.equal(executing.busy, true);
  assert.equal(executing.pendingExecutions, 1);
  assert.equal(executing.activeOperation.name, 'find_assets');
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 1, 'проверка состояния не запускает код и не читает холст');
  await assert.rejects(client.execute('return 2'), error => {
    assert.equal(error.code, 'PLUGIN_BUSY');
    assert.equal(error.operationStatus, 'not_applied');
    assert.match(error.nextStep, /Не запускайте цикл/);
    return true;
  });
  await assert.rejects(client.captureScreenshot('1:2'), error => error.code === 'PLUGIN_BUSY');
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 1);
  assert.equal(commands.includes('CAPTURE_SCREENSHOT'), false);
  busy = false;
  responsive = false;
  assert.equal((await client.executionStatus('ui-file')).responsive, false);
  await assert.rejects(client.execute('return 3'), error => {
    assert.equal(error.code, 'PLUGIN_UNRESPONSIVE');
    assert.equal(error.operationStatus, 'not_applied');
    assert.match(error.nextStep, /get_status/);
    assert.match(error.nextStep, /Сохраните активную вкладку/);
    assert.doesNotMatch(error.nextStep, /Откройте целевую вкладку/);
    return true;
  });
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 1, 'неответивший probe не должен отправлять код в отложенное выполнение');
  responsive = true;
  assert.equal((await client.executionStatus('ui-file')).busy, false);
  assert.deepEqual((await client.execute('return 4')).result, { marker: 'executed' });
  // Simulate the iframe receiving a WS command after its original deadline.
  clockOffset = 120000;
  await assert.rejects(client.execute('return 5'), error => {
    assert.equal(error.code, 'COMMAND_EXPIRED');
    assert.equal(error.operationStatus, 'not_applied');
    return true;
  });
  assert.equal(commands.filter(type => type === 'EXECUTE_CODE').length, 2);
  clockOffset = 0;
  executionFailure = { code: 'FONT_LOAD_TIMEOUT', operationStatus: 'not_applied',
    nextStep: 'Проверьте доступность шрифта', fileKey: 'ui-file',
    retryPolicy: 'after_state_change',
    blockers: [{ type: 'font', family: 'Factor IO', style: 'Bold' }], rollbackErrors: [] };
  await assert.rejects(client.execute('preflight'), error => {
    for (const [key, value] of Object.entries(executionFailure)) assert.deepEqual(error[key], value);
    return true;
  });
  executionFailure = undefined;
  const operationId='dddddddd-dddd-4ddd-addd-dddddddddddd';
  const pendingImport=client.execute('import pending',{fileKey:'ui-file',operation:{name:'import_variables',mutating:true,importInput:{fileKey:'ui-file',operationId,variables:[{key:'a'.repeat(40),resolvedType:'FLOAT'}]}}});
  const disconnectedImport=assert.rejects(pendingImport);
  await waitFor(()=>journalCommand);
  context.__wsDisconnectAll();
  await disconnectedImport;
  for(const event of [{stage:'variable-read',sequence:1,key:'a'.repeat(40),id:'late-native-id'},{stage:'settled',sequence:2,success:false}]) {
    context.onmessage({data:{pluginMessage:{type:'OPERATION_JOURNAL_EVENT',data:{...journalCommand.operation.journal,...event}}}});
  }

  await waitFor(() => !broker.bridge.status().connected);
  assert.equal(context.__wsIsPaused(), true);
  context.__wsManualScan();
  await waitFor(() => broker.bridge.status().connected);
  assert.equal(context.__wsGetAuthenticatedCount(), 1);
  let recovered;
  for(let attempt=0;attempt<30;attempt++) {
    recovered=(await client.operationStatus({fileKey:'ui-file',operationId})).operation;
    if(recovered.settled)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(recovered.settled,true);
  assert.equal(recovered.variables[0].id,'late-native-id');
  assert.equal(commands.filter(type=>type==='EXECUTE_CODE').length,4,'reconnect never repeats import');
  assert.equal(errors.length, 0);
});
