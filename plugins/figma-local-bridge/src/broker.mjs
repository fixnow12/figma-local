import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationJournal } from './operation-journal.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { errorDetails } from './bridge-errors.mjs';
import { FigmaBridge } from './bridge.mjs';
import { installationDirectory, loadInstallation, identityFor } from './installation.mjs';
import { brokerRevision, runtimeInfo, pluginRevision } from './runtime-info.mjs';
import {recoverComponentDryRunSchema,buildComponentDryRunReadbackCode} from './component-dry-run-recovery.mjs';

export async function startBroker({ directory = installationDirectory(), port = 9233, idleMs = 60000, queueTimeoutMs = 5000,
  isRuntimeCurrent = () => brokerRevision() === runtimeInfo.brokerRevision } = {}) {
  const installation = await loadInstallation(directory);
  const journal = new OperationJournal(directory);
  const connectionIds = new WeakMap();
  const connectionId = ws => {if(!connectionIds.has(ws)) connectionIds.set(ws,randomUUID());return connectionIds.get(ws);};
  const queues = new Map();
  const sessions = new Set();
  let idleTimer;
  let restartTimer;
  let restarting = false;
  let activeOperations = 0;
  let hasAcceptedSession = false;
  const uncertainFiles = new Set();
  const bridge = new FigmaBridge({ host: '127.0.0.1', port, portFallback: false, identity: identityFor(installation, 'server'), onMcpConnection });

  function scheduleIdle() {
    clearTimeout(idleTimer);
    // A newly spawned client may need the full six-second discovery window on
    // slower hosts. After the first session, use the configured idle timeout.
    const delay = hasAcceptedSession ? idleMs : Math.max(idleMs, 6000);
    if (!sessions.size && !uncertainFiles.size) idleTimer = setTimeout(() => void stop(), delay);
    idleTimer?.unref?.();
  }
  function status() {
    const full = bridge.status();
    return { ...full, operationJournal:true, file: full.files.length === 1 ? full.files[0] : null };
  }
  function maintenanceStatus() {
    const full = status();
    let runtimeCurrent = false;
    try { runtimeCurrent = isRuntimeCurrent(); }
    catch { /* A moved or removed source directory means this broker is stale. */ }
    if (runtimeCurrent) return full;
    const busy = activeOperations > 0 || queues.size > 0 || uncertainFiles.size > 0;
    if (!busy && !restarting) {
      restarting = true;
      // Let the encrypted status response flush before closing sockets. The
      // restart flag synchronously prevents any later canvas request entering.
      restartTimer = setTimeout(() => void stop(), 50);
    }
    return { ...full, maintenance: { state: restarting ? 'restarting' : 'deferred',
      activeOperations, uncertainFiles: [...uncertainFiles] } };
  }
  async function resolveFile(session, requested) {
    await bridge.waitForConnection(10000);
    if (session.closed) throw new Error('AI-сессия закрыта');
    let target = requested;
    if (!target) {
      const available = status().files;
      if (available.length !== 1) {
        throw new Error(available.length ? `Открыто несколько файлов. Укажите fileKey: ${available.map(file => `${file.fileName} (${file.fileKey})`).join(', ')}` : 'Нет подключённых файлов Figma.');
      }
      target = available[0].fileKey;
    }
    if (typeof target !== 'string' || !bridge.status().files.some(file => file.fileKey === target)) throw new Error('Указанный файл не подключён');
    return target;
  }
  async function runForFile(session, fileKey, operation) {
    const previous = queues.get(fileKey) || Promise.resolve();
    let unlock;
    const current = new Promise(resolve => { unlock = resolve; });
    // Keep the whole chain: cancelling a waiter must not let a later command
    // overtake the operation that is still running in Figma.
    const tail = previous.then(() => current);
    queues.set(fileKey, tail);
    let timer;
    try {
      await Promise.race([
        previous,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Файл выполняет другую операцию. Команда не отправлена в Figma.'), {
            operationStatus: 'not_applied', code: 'FILE_BUSY', fileKey,
            nextStep: 'Дождитесь завершения текущей операции в Bridge. Не запускайте цикл повторов с sleep.',
          })), queueTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (session.closed) throw new Error('AI-сессия закрыта; команда не отправлена в Figma.');
      if (!bridge.status().files.some(file => file.fileKey === fileKey)) throw new Error('Указанный файл не подключён');
      return await operation();
    } finally {
      clearTimeout(timer);
      unlock();
      void tail.then(() => { if (queues.get(fileKey) === tail) queues.delete(fileKey); });
    }
  }

  async function recoverComponentDryRun(session,input) {
    const reject=(code,message)=>{throw Object.assign(Error(message),{code,operationStatus:'not_applied',commandSent:false,operationId:input.operationId});};
    const saved=journal.get(input.fileKey,input.operationId);
    if(saved.recovery&&saved.settled&&saved.argsHash===input.argsHash)
      return {operationStatus:'unknown',operation:saved,alreadyRecovered:true};
    const record=journal.getRecoverableComponentDryRun(input);
    if(restarting||!isRuntimeCurrent())reject('DRY_RUN_RECOVERY_RUNTIME_STALE','Broker не подтверждает текущую сборку');
    return runForFile(session,input.fileKey,async()=>{
      const socket=bridge.wsServer.clients.get(input.fileKey)?.ws;
      const currentConnectionId=socket&&connectionId(socket);
      const assertConnection=()=>{
        const file=bridge.wsServer.clients.get(input.fileKey);
        const liveSockets=new Set([...bridge.wsServer.socketKeys.keys(),...(bridge.wsServer.wss?.clients||[])]);
        const oldAlive=[...liveSockets].some(ws=>connectionIds.get(ws)===record.connectionId&&ws.readyState!==3);
        if(!file||file.ws!==socket||socket.readyState!==1||currentConnectionId===record.connectionId||oldAlive)
          reject('DRY_RUN_RECOVERY_CONNECTION_REJECTED','Старое подключение не завершено или новое подключение изменилось');
        if(file.fileInfo.pluginBuild!==pluginRevision()||!isRuntimeCurrent())
          reject('DRY_RUN_RECOVERY_RUNTIME_STALE','Текущая сборка plugin/broker не подтверждена');
      };
      const assertIdle=value=>{
        if(value?.fileKey!==input.fileKey||value.responsive!==true||value.busy!==false||
          value.pendingExecutions!==0||value.activeOperation!==null)
          reject('DRY_RUN_RECOVERY_NOT_IDLE','Plugin API не подтвердил свободное состояние');
      };
      assertConnection();
      const before=await bridge.executionStatus(input.fileKey);assertConnection();assertIdle(before);
      const read=await bridge.execute(buildComponentDryRunReadbackCode({fileKey:input.fileKey,key:record.operationInput.key}),
        {timeout:10000,fileKey:input.fileKey,expectedSocket:socket,operation:{name:'recover_component_dry_run_readback',mutating:false}});
      assertConnection();
      if(read?.fileContext?.fileKey!==input.fileKey)reject('DRY_RUN_RECOVERY_PROOF_REJECTED','Read-back выполнен для другого файла');
      const after=await bridge.executionStatus(input.fileKey);assertConnection();assertIdle(after);
      const operation=journal.recoverComponentDryRun(input,{oldConnectionAbsent:true,currentConnectionId,before,after,readback:read.result});
      uncertainFiles.delete(input.fileKey);
      return {operationStatus:'unknown',operation};
    });
  }

  function release(session) {
    if (!session.closed || session.pending) return;
    sessions.delete(session);
    scheduleIdle();
  }
  function onMcpConnection(ws) {
    const session = { id: randomUUID(), closed: false, pending: 0, requests: new Set() };
    hasAcceptedSession = true;
    sessions.add(session);
    scheduleIdle();
    return {
      receive(message) {
        if (!message || typeof message.id !== 'string' || message.id.length > 100 || session.requests.has(message.id) || session.pending >= 32) { ws.close(4400, 'Invalid request'); return; }
        session.requests.add(message.id);
        session.pending++;
        void (async () => {
          let fileOperation = false;
          let targetFile;
          try {
            let result;
            if (message.method === 'status') result = maintenanceStatus();
            else if (message.method === 'operationStatus') result = {operationStatus:'read', operation: journal.get(message.args?.fileKey,message.args?.operationId)};
            else if (message.method === 'recoverComponentDryRun') {
              const input=recoverComponentDryRunSchema.parse(message.args);
              fileOperation=true;activeOperations++;
              result=await recoverComponentDryRun(session,input);
            }
            else if (message.method === 'executionStatus') {
              const fileKey = message.args?.fileKey;
              if (typeof fileKey !== 'string' || !status().files.some(file => file.fileKey === fileKey)) throw new Error('Указанный файл не подключён');
              // Readiness bypasses the canvas queue, including a stuck operation.
              result = await bridge.executionStatus(fileKey);
            }
            else if (['execute', 'captureScreenshot'].includes(message.method)) {
              if (restarting) throw Object.assign(new Error('Broker обновляется; команда не отправлена в Figma.'), {
                code: 'BRIDGE_RESTARTING', operationStatus: 'not_applied', nextStep: 'Вызовите get_status для восстановления подключения.',
              });
              fileOperation = true;
              activeOperations++;
              const args = message.args || {};
              const fileKey = await resolveFile(session, args.fileKey);
              targetFile = fileKey;
              if (message.method === 'execute') {
                if (typeof args.code !== 'string' || args.code.length > 8 * 1024 * 1024) throw new Error('Неверная команда');
                const timeout = Math.min(60000, Math.max(1000, Number(args.timeout) || 30000));
                if(args.operation?.name==='swap_nested_components')journal.assertNestedSwapReplayAllowed({fileKey,name:'swap_nested_components',args:args.operation.operationInput});
                const pendingWrite = [...journal.records.values()].find(r=>r.fileKey===fileKey&&!r.settled);
                if(pendingWrite && args.operation?.mutating !== false) throw Object.assign(Error('Предыдущий импорт ещё выполняется; прочитайте его журнал.'),{code:'OPERATION_IN_PROGRESS',operationStatus:'not_applied',commandSent:false,operationId:pendingWrite.operationId,stage:pendingWrite.stage});
                result = await runForFile(session, fileKey, async () => {
                  let record;
                  const socket = bridge.wsServer.clients.get(fileKey)?.ws;
                  let operation = args.operation;
                  const pendingImport = [...journal.records.values()].find(r=>r.fileKey===fileKey&&!r.settled);
                  if(pendingImport && operation?.mutating !== false) throw Object.assign(Error('Предыдущий импорт ещё не завершён; прочитайте журнал операции.'), {code:'OPERATION_IN_PROGRESS',operationStatus:'not_applied',commandSent:false,operationId:pendingImport.operationId,stage:pendingImport.stage});
                  journal.assertNativeImportReplayAllowed({fileKey,name:operation?.name,args:operation?.operationInput,mutating:operation?.mutating,componentImportKeys:operation?.componentImportKeys});
                  if(['import_variables','use_component','swap_nested_components'].includes(operation?.name)) {
                    if(!socket) throw Error('Файл отключён');
                    const input = operation.name==='import_variables'
                      ? operation.importInput
                      : {fileKey,name:operation.name,...(operation.name==='swap_nested_components'?{operationId:operation.operationInput.operationId}:{}),args:{...operation.operationInput,fileKey}};
                    if(input?.fileKey !== fileKey || (operation.name==='import_variables'&&!Array.isArray(input.variables))) throw Error('Неверные аргументы операции');
                    const resumeToken = randomBytes(32).toString('hex');
                    record = journal.begin(input,connectionId(socket),resumeToken);
                    operation = {...operation, journal:{operationId:record.operationId,argsHash:record.argsHash,fileKey,resumeToken}};
                    journal.mark(record.operationId,{commandSent:true});
                  }
                  try { const value = await bridge.execute(args.code, {timeout,fileKey,pageId:args.pageId,expectedSocket:socket,operation});
                    if(record) value.operationId=record.operationId;
                    return value;
                  } catch(error) {
                    if(record) { const current=journal.get(fileKey,record.operationId); if(!current.settled) journal.mark(record.operationId,error.operationStatus==='not_applied'?{state:'failed',settled:true,operationStatus:'not_applied',code:error.code||'OPERATION_NOT_SENT'}:{state:'unknown',operationStatus:'unknown'});
                      Object.assign(error,{operationId:record.operationId,argsHash:record.argsHash,stage:current.stage,commandSent:true,originalErrorCode:error.code||'OPERATION_UNKNOWN'}); }
                    throw error;
                  }
                });
                if (args.operation?.mutating === false) uncertainFiles.delete(fileKey);
              } else result = await runForFile(session, fileKey, () => bridge.captureScreenshot(args.nodeId, { scale: args.scale, fileKey }));
            } else throw new Error('Неизвестная операция Bridge');
            if (!session.closed) ws.send(JSON.stringify({ id: message.id, result }));
          } catch (error) {
            // A failed read/export cannot leave an unconfirmed canvas write.
            // Preserve any earlier uncertain write until a successful read-back.
            const mutating = message.method === 'execute' && message.args?.operation?.mutating !== false;
            if (targetFile && mutating && error.operationStatus === 'unknown') uncertainFiles.add(targetFile);
            if (!session.closed && ws.readyState === 1) ws.send(JSON.stringify({ id: message.id, error: error.message, errorDetails: errorDetails(error) }));
          } finally {
            if (fileOperation) activeOperations--;
            session.pending--;
            session.requests.delete(message.id);
            release(session);
          }
        })();
      },
      close() { session.closed = true; release(session); },
    };
  }
  let stopped = false;
  let onStop;
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(restartTimer);
    clearTimeout(idleTimer);
    await bridge.stop();
    clearTimeout(idleTimer);
    await onStop?.();
  }
  await bridge.start();
  bridge.wsServer.onOperationEvent = (ws,event) => { if(bridge.wsServer.socketKeys.get(ws)!==event?.fileKey)return; const binding=connectionId(ws);journal.event(binding,event);if(journal.acknowledged(binding,event)&&ws.readyState===1)ws.send(JSON.stringify({type:'OPERATION_JOURNAL_ACK',data:{operationId:event.operationId,fileKey:event.fileKey,argsHash:event.argsHash,sequence:event.sequence}})); };
  scheduleIdle();
  return { bridge, stop, set onStop(callback) { onStop = callback; } };
}

async function run() {
  let broker;
  try { broker = await startBroker(); }
  catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void broker.stop());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { process.stderr.write(`Bridge: ${error.message}\n`); process.exitCode = 1; });
}
