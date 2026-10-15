import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { remoteError } from './bridge-errors.mjs';
import channel from './secure-channel.cjs';
import { installationDirectory, loadInstallation, identityFor } from './installation.mjs';
import { HANDSHAKE_MAX_PAYLOAD, SECURE_MAX_PAYLOAD, allowAuthenticatedPayload } from './websocket-limits.mjs';

export function connectSecure(port, identity, { timeout = 2000, onMessage = () => {}, onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: HANDSHAKE_MAX_PAYLOAD, perMessageDeflate: false });
    let ready = false;
    let transportClosed = false;
    const timer = setTimeout(() => { ws.terminate(); reject(Object.assign(new Error('Bridge authentication timeout'), { code: 'BRIDGE_AUTH_TIMEOUT' })); }, timeout);
    const secure = channel.create({
      side: 'client', identity, port,
      send: message => ws.send(JSON.stringify(message)),
      onReady: () => { allowAuthenticatedPayload(ws, SECURE_MAX_PAYLOAD); clearTimeout(timer); ready = true; resolve({ ws, secure }); },
      onMessage,
      onError: error => {
        if (transportClosed) return; // secure.close() reports normal teardown too.
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'BRIDGE_AUTH_REJECTED' }));
        if (ready) onClose(4403);
        ws.close(4403, 'Secure connection rejected');
      },
    });
    ws.on('message', raw => { try { secure.receive(JSON.parse(String(raw))); } catch { ws.close(4400, 'Invalid message'); } });
    ws.on('error', error => { clearTimeout(timer); reject(error); ws.terminate(); });
    ws.on('close', code => {
      transportClosed = true;
      clearTimeout(timer);
      secure.close();
      if (ready) onClose(code);
      else reject(Object.assign(new Error('Bridge connection closed'), { code: code >= 4400 ? 'BRIDGE_AUTH_REJECTED' : 'BRIDGE_CONNECT_CLOSED' }));
    });
  });
}

function interruptedRequest(message, code, method, args) {
  const uncertain = method === 'execute' && args.operation?.mutating !== false;
  return Object.assign(new Error(message), {
    code, operationStatus: uncertain ? 'unknown' : 'not_applied',
    ...(args.fileKey ? { fileKey: args.fileKey } : {}),
    nextStep: uncertain
      ? 'Запись могла выполниться. Восстановите подключение и прочитайте затронутые узлы перед повтором; не отправляйте запись автоматически.'
      : 'Восстановите подключение MCP и повторите чтение.',
  });
}

export class BrokerClient {
  constructor({ directory = installationDirectory(), ports = [9233], autoStart = true } = {}) {
    this.directory = directory;
    this.ports = ports;
    this.autoStart = autoStart;
    this.pending = new Map();
    this.connection = null;
    this.connecting = null;
    this.closed = false;
  }
  async start() { /* Defer local process creation until the first Figma tool call. */ }
  async connect() {
    if (this.closed) throw new Error('AI-сессия Bridge завершена. Перезапустите MCP для нового подключения.');
    if (this.connection) return this.connection;
    if (this.connecting) return this.connecting;
    this.connecting = this.discover().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async discover() {
    const identity = identityFor(await loadInstallation(this.directory), 'mcp');
    let started = false;
    let lastError;
    const deadline = Date.now() + 6000;
    for (let attempt = 0; attempt < (this.autoStart ? 30 : 1); attempt++) {
      if (this.closed) throw new Error('AI-сессия Bridge завершена.');
      if (Date.now() >= deadline) break;
      // Sequential attempts avoid accidentally opening multiple connections.
      for (const port of this.ports) {
        try {
          const connection = await connectSecure(port, identity, {
            timeout: Math.min(2000, Math.max(1, deadline - Date.now())),
            onMessage: message => {
              const pending = this.pending.get(message?.id);
              if (!pending) return;
              clearTimeout(pending.timer);
              this.pending.delete(message.id);
              if (message.error) pending.reject(remoteError(message.error, message.errorDetails));
              else pending.resolve(message.result);
            },
            onClose: code => this.connectionLost(code),
          });
          if (this.closed) { connection.ws.close(); throw new Error('Сессия закрыта'); }
          this.connection = connection;
          return connection;
        } catch (error) {
          lastError = error;
          if (error.code === 'BRIDGE_AUTH_REJECTED') this.closed = true;
          // Permissions and failed trust cannot be repaired by spawning more brokers.
          if (!['ECONNREFUSED', 'ECONNRESET', 'BRIDGE_CONNECT_CLOSED'].includes(error.code)) throw error;
        }
      }
      if (this.autoStart && !started) {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./broker.mjs', import.meta.url))], {
          detached: true, stdio: 'ignore', windowsHide: true,
          env: { ...process.env, FIGMA_LOCAL_STATE_DIR: this.directory },
        });
        child.on('error', error => { lastError = error; });
        child.unref();
        started = true;
      }
      if (this.autoStart) await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Не удалось подключиться к доверенному Bridge. Проверьте установку и порт 9233. ${lastError?.message || ''}`);
  }
  connectionLost(code) {
    this.connection = null;
    if (code >= 4400) this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(interruptedRequest('Bridge отключился; следующий вызов восстановит подключение.', 'BRIDGE_DISCONNECTED', pending.method, pending.args)); }
    this.pending.clear();
  }
  async call(method, args = {}) {
    const { secure } = await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(interruptedRequest('Истекло время ожидания Bridge', 'BRIDGE_TIMEOUT', method, args)); }, ['status', 'executionStatus', 'operationStatus'].includes(method) ? 5000 : 90000);
      this.pending.set(id, { resolve, reject, timer, method, args });
      try { secure.send({ id, method, args }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(interruptedRequest(error.message, 'BRIDGE_SEND_FAILED', method, args)); }
    });
  }
  execute(code, options = {}) { return this.call('execute', { ...options, code }); }
  captureScreenshot(nodeId, options = {}) { return this.call('captureScreenshot', { ...options, nodeId }); }
  reconcileMutation(input) { return this.call('reconcileMutation',input); }
  recoverComponentDryRun(input) { return this.call('recoverComponentDryRun', input); }
  operationStatus(input) { return this.call('operationStatus', input); }
  executionStatus(fileKey) { return this.call('executionStatus', { fileKey }); }
  async status({ fileKey } = {}) {
    let status = await this.readStatus();
    // A freshly started/replaced broker answers before the open plugin's
    // discovery loop and authenticated FILE_INFO arrive (up to ~4s in practice).
    // An unscoped status must collect the whole startup window: the first file
    // to register does not mean the other open plugins are disconnected.
    // A scoped status can finish as soon as that exact file registers.
    // Mature brokers answer immediately. No canvas retries.
    const startedAt = Date.parse(status.runtime?.startedAt);
    const now = Date.now();
    const deadline = startedAt <= now ? Math.min(startedAt + 5000, now + 5000) : now;
    const connected = () => fileKey && status.files?.some(file => file.fileKey === fileKey);
    while (!connected() && !status.maintenance && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      status = await this.readStatus();
    }
    return status;
  }
  async readStatus() {
    // Only status is safe to retry. Never replay execute/captureScreenshot here.
    for (let attempt = 0; attempt < 2; attempt++) {
      let status;
      try { status = await this.call('status'); }
      catch (error) {
        if (attempt === 0 && !this.closed && error.code === 'BRIDGE_DISCONNECTED') continue;
        throw error;
      }
      if (status.maintenance?.state !== 'restarting' || attempt > 0) return status;
      const ws = this.connection?.ws;
      if (ws && ws.readyState !== WebSocket.CLOSED) await new Promise((resolve, reject) => {
        const closed = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          ws.off('close', closed);
          reject(Object.assign(new Error('Broker ещё обновляется. Повторите get_status.'), { code: 'BRIDGE_RESTARTING' }));
        }, 2000);
        ws.once('close', closed);
      });
    }
  }
  async runInFile(fileKey, operation, { requireExplicitFile = false } = {}) {
    const status = await this.status({ fileKey });
    const files = status.files || [];
    if (requireExplicitFile && !fileKey && files.length > 1) {
      throw new Error('Подключено несколько файлов. Укажите fileKey из get_status перед изменением макета.');
    }
    const target = fileKey
      ? files.find(file => file.fileKey === fileKey)
      : files.length === 1 ? files[0] : status.file;
    if (!target) throw new Error(fileKey ? `Целевой файл Figma не подключён: ${fileKey}` : 'Нет подключённого файла Figma.');
    return operation({ fileKey: target.fileKey, pageId: target.currentPageId });
  }
  async stop() {
    this.closed = true;
    const connection = this.connection;
    this.connectionLost();
    connection?.ws.close();
  }
}
