import { createServer as createHttpServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import secureChannel from './secure-channel.cjs';
import { remoteError } from './bridge-errors.mjs';
import { runtimeInfo } from './runtime-info.mjs';
import { HANDSHAKE_MAX_PAYLOAD, SECURE_MAX_PAYLOAD, LEGACY_MAX_PAYLOAD, MAX_PENDING_AUTHENTICATIONS, allowAuthenticatedPayload } from './websocket-limits.mjs';

const DEFAULT_HOST = process.env.FIGMA_WS_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.FIGMA_WS_PORT || 9223);
const SERVER_VERSION = "0.3.0";
export const LOCAL_AUTH_PROTOCOL = "figma-local-bridge-auth-v1";

function resolveAuthToken(authToken) {
  const token = authToken || process.env.FIGMA_BRIDGE_AUTH_TOKEN || randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error("FIGMA_BRIDGE_AUTH_TOKEN должен содержать не менее 32 символов base64url");
  }
  return token;
}

export function createAuthProof(authToken, role, port, challenge) {
  if (role !== "client" && role !== "server") throw new Error(`Неизвестная роль аутентификации: ${role}`);
  return createHmac("sha256", authToken)
    .update(`${LOCAL_AUTH_PROTOCOL}:${role}:${port}:${challenge}`, "utf8")
    .digest("base64url");
}

function proofsMatch(actual, expected) {
  if (typeof actual !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(actual)) return false;
  const actualBuffer = Buffer.from(actual, "ascii");
  const expectedBuffer = Buffer.from(expected, "ascii");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAllowedOrigin(origin) {
  return !origin || origin === "null" || origin === "https://www.figma.com" || origin === "https://figma.com";
}

export class LocalFigmaWebSocketServer {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, authToken, identity, onMcpConnection } = {}) {
    if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Bridge разрешён только на loopback');
    this.host = host;
    this.requestedPort = port;
    this.port = null;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Map();
    this.socketKeys = new Map();
    this.pendingRequests = new Map();
    this.activeFileKey = null;
    this.requestCounter = 0;
    this.startedAt = Date.now();
    this.heartbeat = null;
    this.authToken = resolveAuthToken(authToken);
    this.authStates = new WeakMap();
    this.pendingAuthentications = new Set();
    this.identity = identity;
    this.onMcpConnection = onMcpConnection;
  }

  handleHttpRequest(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/" || request.url === "/health") {
      const connectedClients = [...this.clients.values()].filter((client) => client.ws.readyState === WebSocket.OPEN).length;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        version: SERVER_VERSION,
        clients: this.clients.size,
        connectedClients,
        authRequired: true,
        authProtocol: this.identity ? secureChannel.protocol : LOCAL_AUTH_PROTOCOL,
        uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not Found");
  }

  async start() {
    if (this.httpServer) return;
    this.startedAt = Date.now();
    this.httpServer = createHttpServer((request, response) => this.handleHttpRequest(request, response));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      maxPayload: HANDSHAKE_MAX_PAYLOAD,
      perMessageDeflate: false,
      verifyClient: ({ origin }, accept) => {
        if (!isAllowedOrigin(origin)) return accept(false, 403, 'Unauthorized Origin');
        if (this.pendingAuthentications.size >= MAX_PENDING_AUTHENTICATIONS) return accept(false, 503, 'Authentication capacity reached');
        accept(true);
      },
    });
    // ws повторно публикует ошибки общего HTTP-сервера. Постоянный обработчик
    // не даёт второму событию EADDRINUSE завершить процесс после отклонения start().
    this.wss.on("error", () => {});
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.httpServer?.off("error", onError);
        this.httpServer?.off("listening", onListening);
        this.wss?.off("error", onError);
      };
      const onError = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      this.httpServer.on("error", onError);
      this.httpServer.on("listening", onListening);
      this.wss.on("error", onError);
      this.httpServer.listen(this.requestedPort, this.host);
    });
    const address = this.httpServer.address();
    this.port = typeof address === "object" && address ? address.port : this.requestedPort;
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss?.clients || []) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
    this.heartbeat.unref?.();
  }

  handleConnection(ws) {
    // Install before either protocol branch: receiver errors precede message.
    ws.on('error', () => ws.terminate());
    this.pendingAuthentications.add(ws);
    const timer = setTimeout(() => ws.terminate(), 5000);
    timer.unref?.();
    const release = () => { clearTimeout(timer); this.pendingAuthentications.delete(ws); };
    ws.once('close', release);
    const authenticate = () => {
      allowAuthenticatedPayload(ws, this.identity ? SECURE_MAX_PAYLOAD : LEGACY_MAX_PAYLOAD);
      release();
    };
    if (this.identity) return this.handleSecureConnection(ws, authenticate);
    ws.isAlive = true;
    const challenge = randomBytes(24).toString("base64url");
    this.authStates.set(ws, { authenticated: false, challenge, authenticate });
    ws.on("pong", () => {
      ws.isAlive = true;
      const fileKey = this.socketKeys.get(ws);
      const client = fileKey ? this.clients.get(fileKey) : null;
      if (client) client.lastPongAt = Date.now();
    });
    ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(Buffer.from(data).toString("utf8")), ws);
      } catch {
        // Некорректное сообщение не должно завершать сервер или другие соединения.
      }
    });
    ws.on("close", () => this.handleDisconnect(ws));
    ws.send(JSON.stringify({
      type: "PLUGIN_UPDATE_AVAILABLE",
      data: { reason: "local-auth-required" },
    }));
    ws.send(JSON.stringify({
      type: "AUTH_CHALLENGE",
      data: { authProtocol: LOCAL_AUTH_PROTOCOL, port: this.port, challenge },
    }));
  }

  handleSecureConnection(ws, authenticate) {
    ws.isAlive = true;
    const rawSend = ws.send.bind(ws);
    let role, mcp;
    const secure = secureChannel.create({
      side: 'server', identity: this.identity, port: this.port,
      send: message => rawSend(JSON.stringify(message)),
      onReady: peerRole => {
        authenticate();
        role = peerRole;
        if (role === 'plugin') this.authStates.set(ws, { authenticated: true });
        else if (role === 'mcp') mcp = this.onMcpConnection?.(ws);
        else ws.close(4403, 'Unsupported role');
      },
      onMessage: message => {
        if (role === 'plugin') this.handleMessage(message, ws);
        else if (role === 'mcp') mcp?.receive(message);
      },
      onError: () => ws.close(4403, 'Secure connection rejected'),
    });
    // All existing command/result paths now pass through the encrypted channel.
    ws.send = value => secure.send(JSON.parse(String(value)));
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      try { secure.receive(JSON.parse(String(raw))); } catch { ws.close(4400, 'Invalid message'); }
    });
    ws.on('close', () => {
      secure.close();
      if (role === 'plugin') this.handleDisconnect(ws);
      mcp?.close();
    });
    secure.start();
  }

  handleMessage(message, ws) {
    const authState = this.authStates.get(ws);
    if (!authState?.authenticated) {
      if (message.type !== "AUTH_RESPONSE") return;
      if (!message.data || message.data.authProtocol !== LOCAL_AUTH_PROTOCOL) {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", data: { error: "Несовместимый протокол локального сопряжения" } }));
        ws.close(4406, "Unsupported authentication protocol");
        return;
      }
      const expected = createAuthProof(this.authToken, "client", this.port, authState.challenge);
      if (!proofsMatch(message.data.proof, expected)) {
        ws.send(JSON.stringify({ type: "AUTH_ERROR", data: { error: "Неверный код локального сопряжения" } }));
        ws.close(4403, "Authentication failed");
        return;
      }
      authState.authenticate();
      authState.authenticated = true;
      ws.send(JSON.stringify({
        type: "AUTH_OK",
        data: {
          authProtocol: LOCAL_AUTH_PROTOCOL,
          port: this.port,
          proof: createAuthProof(this.authToken, "server", this.port, authState.challenge),
          serverVersion: SERVER_VERSION,
          startedAt: this.startedAt,
        },
      }));
      return;
    }
    if (message.type === 'OPERATION_JOURNAL_EVENT') { this.onOperationEvent?.(ws, message.data); return; }
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending.ws === ws) {
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.id);
        if (message.error) pending.reject(remoteError(message.error, message.errorDetails));
        else pending.resolve(message.result);
        return;
      }
    }
    if (message.type === "FILE_INFO" && message.data) {
      this.registerFile(message.data, ws);
      return;
    }
    const fileKey = this.socketKeys.get(ws);
    const client = fileKey ? this.clients.get(fileKey) : null;
    if (!client) return;
    client.lastActivity = Date.now();
    if (message.type === "SELECTION_CHANGE") {
      client.selection = message.data || null;
      this.activeFileKey = fileKey;
    } else if (message.type === "PAGE_CHANGE" && message.data) {
      client.fileInfo.currentPage = message.data.pageName;
      client.fileInfo.currentPageId = message.data.pageId || null;
      this.activeFileKey = fileKey;
    }
  }

  registerFile(data, ws) {
    if (!this.authStates.get(ws)?.authenticated) return;
    const fileKey = typeof data.fileKey === "string" && data.fileKey ? data.fileKey : null;
    if (!fileKey) return;
    const previousKey = this.socketKeys.get(ws);
    if (previousKey && previousKey !== fileKey) {
      ws.close(4409, "fileKey cannot change within a session");
      return;
    }
    const existing = this.clients.get(fileKey);
    if (existing && existing.ws !== ws) {
      this.rejectPendingForFile(fileKey, "Соединение с файлом Figma было заменено");
      existing.ws.terminate();
    }
    this.socketKeys.set(ws, fileKey);
    this.clients.set(fileKey, {
      ws,
      fileInfo: {
        fileName: data.fileName || "Без названия",
        fileKey,
        currentPage: data.currentPage || null,
        currentPageId: data.currentPageId || null,
        editorType: data.editorType || "figma",
        connectedAt: Date.now(),
        pluginVersion: data.pluginVersion || null,
        pluginBuild: data.pluginBuild || null,
      },
      selection: existing?.selection || null,
      lastActivity: Date.now(),
      lastPongAt: Date.now(),
    });
    this.activeFileKey = fileKey;
  }

  handleDisconnect(ws) {
    const fileKey = this.socketKeys.get(ws);
    this.socketKeys.delete(ws);
    if (!fileKey) return;
    const client = this.clients.get(fileKey);
    if (client?.ws !== ws) return;
    this.clients.delete(fileKey);
    this.rejectPendingForFile(fileKey, "Плагин Figma отключился");
    if (this.activeFileKey === fileKey) {
      this.activeFileKey = [...this.clients.entries()].find(([, value]) => value.ws.readyState === WebSocket.OPEN)?.[0] || null;
    }
  }

  sendCommand(method, params = {}, timeoutMs = 15000, targetFileKey, expectedSocket) {
    const fileKey = targetFileKey || this.activeFileKey;
    if (!fileKey) return Promise.reject(new Error("Нет активного файла. Откройте Desktop Bridge в нужном файле Figma."));
    const client = this.clients.get(fileKey);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`Файл Figma не подключён: ${fileKey}`));
    if (expectedSocket && client.ws !== expectedSocket) return Promise.reject(new Error("Подключение файла изменилось. Повторите чтение макета."));
    const id = `codex_${++this.requestCounter}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        const error = new Error(`Команда ${method} не завершилась за ${timeoutMs} мс. Результат неизвестен: проверьте макет перед повтором.`);
        error.operationStatus = "unknown";
        error.code = "PLUGIN_RESPONSE_TIMEOUT";
        error.fileKey = fileKey;
        error.nextStep = `Проверьте get_status для целевого fileKey и журнал Bridge файла ${client.fileInfo.fileName}. При проверке фоновой работы сохраните активную вкладку и зафиксируйте отсутствие ответа Plugin API; переключение фокуса не доказывает исправление. Соединение WebSocket и isActive не доказывают готовность Plugin API. Не повторяйте запись автоматически; после восстановления сначала прочитайте затронутые узлы.`;
        reject(error);
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeoutId, fileKey, method, ws: client.ws });
      try {
        client.ws.send(JSON.stringify({ id, method, params, expiresAt: Date.now() + timeoutMs }));
        client.lastActivity = Date.now();
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  rejectPendingForFile(fileKey, reason) {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.fileKey !== fileKey) continue;
      clearTimeout(pending.timeoutId);
      const error = new Error(reason + ". Результат отправленной команды неизвестен.");
      error.operationStatus = "unknown";
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  isClientConnected() {
    return [...this.clients.values()].some((client) => client.ws.readyState === WebSocket.OPEN);
  }

  hasPendingAuthentication() {
    return [...(this.wss?.clients || [])].some((ws) =>
      ws.readyState === WebSocket.OPEN && !this.authStates.get(ws)?.authenticated
    );
  }

  getPairingReference() {
    if (this.identity) return null;
    if (!this.port) return null;
    return `${this.port}:${this.authToken}`;
  }

  getConnectedFileInfo() {
    return this.activeFileKey ? this.clients.get(this.activeFileKey)?.fileInfo || null : null;
  }

  getConnectedFiles() {
    return [...this.clients.entries()]
      .filter(([, client]) => client.ws.readyState === WebSocket.OPEN)
      .map(([fileKey, client]) => ({ ...client.fileInfo, isActive: fileKey === this.activeFileKey }));
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("WebSocket-сервер остановлен"));
    }
    this.pendingRequests.clear();
    for (const ws of this.wss?.clients || []) ws.terminate();
    if (this.wss) await new Promise((resolve) => this.wss.close(() => resolve()));
    if (this.httpServer) await new Promise((resolve) => this.httpServer.close(() => resolve()));
    this.clients.clear();
    this.socketKeys.clear();
    this.activeFileKey = null;
    this.wss = null;
    this.httpServer = null;
    this.port = null;
  }
}

export class FigmaBridge {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, authToken, identity, onMcpConnection, portFallback = true } = {}) {
    this.portFallback = portFallback;
    this.host = host;
    this.preferredPort = port;
    this.wsServer = null;
    this.port = null;
    this.authToken = resolveAuthToken(authToken);
    this.fileQueues = new Map();
    this.identity = identity;
    this.onMcpConnection = onMcpConnection;
  }

  async start() {
    let lastError;
    const attempts = (this.preferredPort === 0 || !this.portFallback) ? [this.preferredPort] : Array.from({ length: 10 }, (_, index) => this.preferredPort + index);
    for (const port of attempts) {
      const candidate = new LocalFigmaWebSocketServer({ port, host: this.host, authToken: this.authToken, identity: this.identity, onMcpConnection: this.onMcpConnection });
      try {
        await candidate.start();
        this.wsServer = candidate;
        this.port = candidate.port;
        return { host: this.host, port: this.port };
      } catch (error) {
        lastError = error;
        await candidate.stop().catch(() => {});
        if (!["EADDRINUSE", "EACCES"].includes(error?.code)) throw error;
      }
    }
    throw lastError || new Error("Не удалось открыть WebSocket-порты 9223–9232");
  }

  async waitForConnection(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.wsServer?.isClientConnected()) return this.wsServer.getConnectedFileInfo();
      if (!this.identity && this.wsServer?.hasPendingAuthentication()) {
        throw new Error(
          `Desktop Bridge ждёт локального сопряжения. Вставьте код ${this.wsServer.getPairingReference()} в поле Local pairing в плагине Figma.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Desktop Bridge не подключён к ws://${this.host}:${this.port}. Откройте плагин в целевом файле Figma.`);
  }

  async runInFile(fileKey, operation, { requireExplicitFile = false } = {}) {
    await this.waitForConnection();
    const files = this.wsServer.getConnectedFiles();
    if (requireExplicitFile && !fileKey && files.length > 1) {
      throw new Error("Подключено несколько файлов. Укажите fileKey из get_status перед изменением макета.");
    }
    const target = files.find((file) => fileKey ? file.fileKey === fileKey : file.isActive);
    if (!target) throw new Error("Целевой файл Figma не подключён: " + fileKey);
    const socket = this.wsServer.clients.get(target.fileKey)?.ws;
    const context = { fileKey: target.fileKey, pageId: target.currentPageId, expectedSocket: socket };
    const previous = this.fileQueues.get(target.fileKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      if (this.wsServer.clients.get(target.fileKey)?.ws !== socket) {
        throw new Error("Подключение файла изменилось в очереди. Повторите чтение макета.");
      }
      return operation(context);
    });
    this.fileQueues.set(target.fileKey, current);
    try {
      return await current;
    } finally {
      if (this.fileQueues.get(target.fileKey) === current) this.fileQueues.delete(target.fileKey);
    }
  }

  async execute(code, { timeout = 30000, fileKey, pageId, expectedSocket, operation } = {}) {
    await this.waitForConnection();
    if (pageId) code = `if (figma.currentPage.id !== ${JSON.stringify(pageId)}) { const error = new Error("Активная страница изменилась. Повторите чтение макета."); error.operationStatus = "not_applied"; throw error; }\n` + code;
    const targetInfoBefore = this.wsServer.getConnectedFiles().find((file) => file.fileKey === fileKey) || this.wsServer.getConnectedFileInfo();
    const metadata = operation ? { ...operation, name: operation.name, mutating: operation.mutating,
      fileName: targetInfoBefore?.fileName, pageName: targetInfoBefore?.currentPage, pageId } : undefined;
    // Allow the iframe readiness probe (2s) and result relay outside the execution budget.
    const response = await this.wsServer.sendCommand("EXECUTE_CODE", { code, timeout, ...(metadata ? { operation: metadata } : {}) }, timeout + 5000, fileKey, expectedSocket);
    if (!response?.success) {
      const error = remoteError(response?.error || "Figma Plugin API вернул ошибку", response);
      error.operationStatus = response?.operationStatus || "unknown";
      error.rollbackErrors = response?.rollbackErrors;
      throw error;
    }
    const targetInfo = this.wsServer.getConnectedFiles().find((file) => file.fileKey === fileKey) || this.wsServer.getConnectedFileInfo();
    return {
      result: response.result,
      resultAnalysis: response.resultAnalysis,
      fileContext: { ...targetInfo, ...response.fileContext, fileKey: fileKey || response.fileContext?.fileKey || targetInfo?.fileKey },
    };
  }

  async executionStatus(fileKey) {
    try {
      const response = await this.wsServer.sendCommand("GET_EXECUTION_STATUS", {}, 3000, fileKey);
      if (!response?.success || typeof response.busy !== 'boolean') throw new Error('Invalid execution status');
      return { fileKey, responsive: true, busy: response.busy, pendingExecutions: response.pendingExecutions,
        activeOperation: response.activeOperation || null };
    } catch (error) {
      return { fileKey, responsive: false, code: error.code || 'PLUGIN_UNRESPONSIVE', error: error.message };
    }
  }

  status() {
    const startedAt = this.wsServer?.startedAt ?? Date.parse(runtimeInfo.startedAt);
    return {
      runtime: { ...runtimeInfo, startedAt: new Date(startedAt).toISOString() },
      version: SERVER_VERSION,
      host: this.host,
      port: this.port,
      connected: this.wsServer?.isClientConnected() || false,
      file: this.wsServer?.getConnectedFileInfo() || null,
      files: this.wsServer?.getConnectedFiles() || [],
    };
  }

  getPairingReference() {
    return this.wsServer?.getPairingReference() || null;
  }

  async captureScreenshot(nodeId, { scale = 1, fileKey, expectedSocket } = {}) {
    await this.waitForConnection();
    // The UI export has a 30s budget; leave room for its 2s readiness probe and relay.
    const response = await this.wsServer.sendCommand("CAPTURE_SCREENSHOT", { nodeId, format: "PNG", scale }, 35000, fileKey, expectedSocket);
    if (!response?.success) throw remoteError(response?.error || "Не удалось получить снимок Figma", response);
    return response.image;
  }

  async stop() {
    await this.wsServer?.stop();
  }
}
