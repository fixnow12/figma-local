import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createAuthProof, LOCAL_AUTH_PROTOCOL } from "../src/bridge.mjs";
import { createFigmaMock, executeGenerated } from "./helpers/figma-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP публикует типизированные схемы без unknown на верхнем уровне", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "server.mjs")],
    cwd: root,
    env: {
      ...process.env,
      FIGMA_WS_HOST: "127.0.0.1",
      FIGMA_WS_PORT: "0",
      LOG_LEVEL: "silent",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "tool-schema-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    function checkArrays(schema, path) {
      if (!schema || typeof schema !== "object") return;
      assert.equal(Array.isArray(schema.items), false, `${path}: tuple-style items скрывает инструмент в MCP-клиентах`);
      for (const [key, value] of Object.entries(schema)) checkArrays(value, `${path}.${key}`);
    }
    for (const tool of tools) checkArrays(tool.inputSchema, tool.name);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["activate_page", "assemble_library_template", "bind_variables", "capture_library_template", "clone_nodes", "export_assets", "find_assets", "get_file_metadata", "get_operation_status", "get_page_settings", "get_status", "import_variables", "inspect_selection", "move_nodes", "patch_nodes", "read_catalog_example", "read_catalog_inventory", "recreate_screen", "render_screen", "resolve_resource_keys", "resolve_variables", "scan_catalog_page", "set_file_metadata", "set_node_variable_modes", "set_page_settings", "set_reactions", "set_text_links", "use_component"],
    );

    const resolver=tools.find(tool=>tool.name==='resolve_resource_keys');
    assert.equal(resolver.annotations.readOnlyHint,true);assert.equal(resolver.inputSchema.properties.variableIds.items.type,'string');assert.equal(resolver.inputSchema.properties.nodeIds.items.type,'string');
    const resolved = tools.find(tool => tool.name === 'resolve_variables');
    assert.equal(resolved.annotations.readOnlyHint, true);
    assert.ok(resolved.inputSchema.properties.variables.items.required.includes('id'));
    const imported = tools.find(tool => tool.name === 'import_variables');
    assert.equal(imported.annotations.readOnlyHint, false);
    assert.equal(imported.annotations.idempotentHint, true);
    assert.equal(imported.inputSchema.properties.variables.maxItems, 100);
    assert.deepEqual(imported.inputSchema.properties.variables.items.required, ['key', 'resolvedType']);
    const activate = tools.find((tool) => tool.name === "activate_page");
    const capture = tools.find(tool => tool.name === 'capture_library_template');
    assert.equal(capture.annotations.readOnlyHint, true);
    assert.equal(capture.inputSchema.properties.pageIds.type, 'array');
    const assemble = tools.find(tool => tool.name === 'assemble_library_template');
    assert.deepEqual(assemble.inputSchema.properties.mode.enum, ['apply', 'verify']);
    assert.equal(assemble.inputSchema.properties.snapshot.properties.nodes.maxItems, 1000);
    assert.equal(activate.inputSchema.properties.pageId.type, "string");
    assert.equal(activate.annotations.idempotentHint, true);
    const getMetadata = tools.find((tool) => tool.name === "get_file_metadata");
    assert.equal(getMetadata.annotations.readOnlyHint, true);
    const setMetadata = tools.find((tool) => tool.name === "set_file_metadata");
    assert.equal(setMetadata.inputSchema.properties.thumbnailNodeId.type, "string");
    assert.equal(setMetadata.annotations.idempotentHint, true);

    const render = tools.find((tool) => tool.name === "render_screen");
    const recreate = tools.find((tool) => tool.name === "recreate_screen");
    assert.ok(recreate.inputSchema.required.includes("fileKey"));
    assert.ok(recreate.inputSchema.required.includes("sourceId"));
    const change = recreate.inputSchema.properties.changes.items;
    assert.equal(change.properties.sourceId.type, "string");
    assert.deepEqual(change.properties.action.enum, ["update", "remove", "replace", "append"]);
    assert.equal(change.properties.set.type, "object");
    assert.equal(change.properties.set.properties.content.type, "string");
    assert.equal(change.properties.nodes.type, "array");
    assert.equal(change.properties.nodes.items.properties.type.type, "string");
    const statusTool = tools.find(tool => tool.name === "get_status");
    assert.equal(statusTool.inputSchema.properties.fileKey?.type, "string");
    const status = await client.callTool({ name: "get_status", arguments: { fileKey: "missing-file" } });
    assert.equal(status.structuredContent.operationStatus, "read", "успешный статус неподключённой цели доказывает чтение");
    assert.deepEqual(status.structuredContent.target, { fileKey: "missing-file", connected: false });
    assert.equal(status.structuredContent.diagnostics.ready, false);
    assert.equal(status.isError, undefined);
    assert.equal(status.structuredContent.connected, false);
    assert.match(status.structuredContent.pairingReference, /^\d+:/);
    const spec = render.inputSchema.properties.spec;
    assert.equal(spec.type, "object");
    assert.equal(spec.properties.nodes.type, "array");
    assert.deepEqual(
      [...spec.properties.nodes.items.properties.type.enum].sort(),
      ["booleanOperation", "component", "componentSet", "ellipse", "frame", "image", "line", "polygon", "rectangle", "star", "svg", "text", "vector"],
    );
    assert.equal(spec.properties.tokens.type, "object");
    assert.equal(JSON.stringify(render.inputSchema).includes('"$ref"'), false);
    assert.equal(spec.properties.nodes.items.properties.fontStyle.type, "string");
    assert.equal(spec.properties.nodes.items.properties.textRuns.type, "array");
    assert.equal(spec.properties.effects.type, "array");
    assert.equal(spec.properties.nodes.items.properties.effects.type, "array");

    const useComponent = tools.find((tool) => tool.name === "use_component");
    assert.ok(
      useComponent.inputSchema.properties.key.type === "string" ||
        typeof useComponent.inputSchema.properties.key.$ref === "string",
    );
    assert.equal(useComponent.inputSchema.properties.sourceKey.type, "string");
    assert.equal(useComponent.inputSchema.properties.libraryKey.type, "string");
    assert.equal(useComponent.inputSchema.properties.variant.type, "object");

    const patchNodes = tools.find((tool) => tool.name === "patch_nodes");
    const patchProperties = patchNodes.inputSchema.properties.patches.items.properties;
    assert.equal(patchProperties.key.type, "string");
    assert.equal(patchProperties.id.type, "string");
    assert.equal(patchProperties.append.type, "array");

    const inspectSelection = tools.find((tool) => tool.name === "inspect_selection");
    assert.equal(inspectSelection.inputSchema.properties.nodeId.type, "string");
    assert.equal(inspectSelection.inputSchema.properties.nodeIds.type, "array");
    assert.deepEqual(inspectSelection.inputSchema.properties.detail.enum, ["compact", "full"]);
    assert.equal(useComponent.inputSchema.properties.sourceId.type, "string");
    assert.equal(useComponent.inputSchema.properties.parentId.type, "string");
    assert.equal(patchNodes.annotations.idempotentHint, false);
    const clone = tools.find((tool) => tool.name === "clone_nodes");
    assert.equal(clone.inputSchema.properties.copies.items.properties.sourceId.type, "string");
    assert.equal(clone.annotations.idempotentHint, false);
    const move = tools.find((tool) => tool.name === "move_nodes");
    assert.equal(move.inputSchema.properties.moves.items.properties.parentId.type, "string");
    const assets = tools.find((tool) => tool.name === "find_assets");
    assert.equal(assets.annotations.readOnlyHint, true);
    assert.ok(assets.inputSchema.properties.kind.enum.includes("variables"));
    assert.match(assets.description, /library_collections.*collectionKey.*library_variables/s);
    assert.match(assets.inputSchema.properties.collectionKey.description, /обязател.*library_variables/i);
    const invalidLibraryVariables = await client.callTool({ name: "find_assets", arguments: { kind: "library_variables" } });
    assert.equal(invalidLibraryVariables.isError, true);
    assert.equal(invalidLibraryVariables.structuredContent.operationStatus, "not_applied");
    assert.equal(invalidLibraryVariables.structuredContent.code, "INVALID_ARGUMENTS");
    assert.match(invalidLibraryVariables.structuredContent.error, /collectionKey/);
    const nodeModes = tools.find(tool => tool.name === 'set_node_variable_modes');
    assert.equal(nodeModes.annotations.idempotentHint, true);
    assert.equal(nodeModes.inputSchema.properties.bindings.maxItems, 40);
    assert.deepEqual(nodeModes.inputSchema.properties.bindings.items.required.sort(), ['anchorVariableKey', 'collectionKey', 'modeName', 'nodeId']);
    assert.ok(nodeModes.inputSchema.required.includes('fileKey'));
    const bindings = tools.find((tool) => tool.name === "bind_variables");
    assert.equal(bindings.inputSchema.properties.bindings.items.properties.nodeId.type, "string");
    assert.equal(bindings.inputSchema.properties.allowComponentChanges.type, "boolean");
  } finally {
    await client.close();
  }
});

test("MCP → WebSocket → сгенерированный патч: ошибка PNG сохраняет успешный результат", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "server.mjs")], cwd: root,
    env: { ...process.env, FIGMA_WS_HOST: "127.0.0.1", FIGMA_WS_PORT: "0" }, stderr: "pipe",
  });
  const client = new Client({ name: "operation-test", version: "0.1.0" });
  const mock = createFigmaMock();
  const text = mock.key(mock.make("TEXT"), "title");
  const otherPage = mock.make("PAGE", { name: "Другая страница" }, null);
  mock.figma.root.children.push(otherPage);
  const cover = mock.make("FRAME", { name: "Обложка" }, otherPage);
  let socket;
  const operations = [];
  try {
    await client.connect(transport);
    const status = await client.callTool({ name: "get_status", arguments: {} });
    const [port, token] = status.structuredContent.pairingReference.split(":");
    socket = new WebSocket("ws://127.0.0.1:" + port);
    const registered = new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", async (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "AUTH_CHALLENGE") {
          socket.send(JSON.stringify({ type: "AUTH_RESPONSE", data: { authProtocol: LOCAL_AUTH_PROTOCOL, proof: createAuthProof(token, "client", Number(port), message.data.challenge) } }));
        } else if (message.type === "AUTH_OK") {
          socket.send(JSON.stringify({ type: "FILE_INFO", data: { fileKey: "test-file", fileName: "Тест", currentPageId: mock.page.id } }));
          // A ping/pong round trip ensures FILE_INFO has been consumed before the tool call.
          socket.once("pong", resolve);
          socket.ping();
        } else if (message.method === "EXECUTE_CODE") {
          operations.push(message.params.operation);
          try {
            const result = await executeGenerated(mock.figma, message.params.code);
            socket.send(JSON.stringify({ id: message.id, result: { success: true, result } }));
            if (message.params.operation?.name === "activate_page") {
              socket.send(JSON.stringify({ type: "PAGE_CHANGE", data: { pageId: mock.figma.currentPage.id, pageName: mock.figma.currentPage.name } }));
            }
          } catch (error) {
            socket.send(JSON.stringify({ id: message.id, result: { success: false, error: error.message, operationStatus: error.operationStatus } }));
          }
        } else if (message.method === "CAPTURE_SCREENSHOT") {
          socket.send(JSON.stringify({ id: message.id, result: { success: false, error: "Экспорт недоступен" } }));
        }
      });
    });
    await registered;
    const missingTarget = await client.callTool({ name: "get_status", arguments: { fileKey: "missing-file" } });
    assert.equal(missingTarget.structuredContent.operationStatus, "read", "успешный статус отсутствующей цели доказывает чтение");
    assert.equal(missingTarget.structuredContent.connected, true);
    assert.deepEqual(missingTarget.structuredContent.target, { fileKey: "missing-file", connected: false });
    assert.equal(missingTarget.structuredContent.diagnostics.ready, false);
    assert.ok(missingTarget.structuredContent.diagnostics.issues.some(issue => issue.code === "TARGET_FILE_NOT_CONNECTED"));
    const presentTarget = await client.callTool({ name: "get_status", arguments: { fileKey: "test-file" } });
    assert.equal(presentTarget.structuredContent.operationStatus, "read", "успешный статус подключённой цели доказывает чтение");
    assert.deepEqual(presentTarget.structuredContent.target, { fileKey: "test-file", connected: true });
    assert.equal(operations.length, 0, "проверка статуса не посылает команды на холст");
    const response = await client.callTool({ name: "patch_nodes", arguments: {
      fileKey: "test-file", patches: [{ id: text.id, set: { content: "Готово", fontSize: 18 } }], screenshotKey: "title",
    } });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.operationStatus, "applied");
    assert.equal(response.structuredContent.screenshot.status, "failed");
    assert.equal(response.structuredContent.fileContext.fileKey, "test-file");
    assert.equal(text.characters, "Готово");
    assert.equal(text.fontSize, 18);
    const found = await client.callTool({ name: "find_assets", arguments: { kind: "nodes", types: ["TEXT"], fileKey: "test-file" } });
    assert.equal(found.structuredContent.result.items[0].id, text.id);
    const cloned = await client.callTool({ name: "clone_nodes", arguments: { copies: [{ sourceId: text.id, key: "title-copy" }], fileKey: "test-file" } });
    assert.equal(cloned.isError, undefined);
    const copyId = cloned.structuredContent.result.copies[0].id;
    assert.notEqual(copyId, text.id);
    const moved = await client.callTool({ name: "move_nodes", arguments: { moves: [{ id: copyId, index: 0 }], fileKey: "test-file" } });
    assert.equal(moved.isError, undefined);
    assert.equal(mock.page.children[0].id, copyId);
    mock.addVariable({ id: "font-size", value: 22 });
    const bound = await client.callTool({ name: "bind_variables", arguments: { bindings: [{ nodeId: copyId, field: "fontSize", variableId: "font-size" }], fileKey: "test-file" } });
    assert.equal(bound.isError, undefined);
    assert.equal(mock.nodes.get(copyId).boundVariables.fontSize.id, "font-size");
    assert.equal(text.fontSize, 18);
    assert.deepEqual(operations.map((operation) => operation.name), ["patch_nodes", "find_assets", "clone_nodes", "move_nodes", "bind_variables"]);
    const linkArgs = { fileKey: "test-file", links: [{ nodeId: text.id, target: { type: "URL", value: "https://example.com" } }] };
    const checked = await client.callTool({ name: "set_text_links", arguments: { ...linkArgs, dryRun: true, screenshot: true } });
    assert.equal(checked.structuredContent.operationStatus, "read");
    assert.equal(checked.structuredContent.result.dryRun, true);
    assert.equal(checked.structuredContent.screenshot, undefined);
    assert.equal(text.hyperlink, null);
    const linked = await client.callTool({ name: "set_text_links", arguments: linkArgs });
    assert.equal(linked.isError, undefined);
    assert.equal(linked.structuredContent.operationStatus, "applied");
    assert.equal(text.hyperlink.value, "https://example.com");
    text.reactions = [];
    text.setReactionsAsync = async function(reactions) { this.reactions = reactions; };
    const reacted = await client.callTool({ name: "set_reactions", arguments: { fileKey: "test-file", updates: [{ nodeId: text.id, reactions: [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }] }] } });
    assert.equal(reacted.isError, undefined);
    assert.equal(text.reactions[0].actions[0].type, "BACK");
    assert.deepEqual(operations.slice(-3).map(op => [op.name, op.mutating]), [["set_text_links", false], ["set_text_links", true], ["set_reactions", true]]);
    assert.equal(operations[1].mutating, false);
    assert.ok(operations.every((operation) => operation.fileName === "Тест" && operation.pageId === mock.page.id));
    const invalid = await client.callTool({ name: "patch_nodes", arguments: { fileKey: "test-file", patches: [{ id: mock.page.id, set: { content: "Нельзя" } }] } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.operationStatus, "not_applied");
    const countBeforePreflight = mock.nodes.size;
    const preflight = await client.callTool({ name: "render_screen", arguments: {
      fileKey: "test-file", dryRun: true, screenshot: true,
      spec: { key: "cover", name: "Обложка", type: "screen", width: 1440, height: 900,
        nodes: [{ type: "text", key: "cover-title", name: "Название", content: "Layouts & Grid", fontFamily: "Factor IO", fontStyle: "Bold" }] },
    } });
    assert.equal(preflight.isError, undefined);
    assert.equal(preflight.structuredContent.operationStatus, "read");
    assert.equal(preflight.structuredContent.result.ready, true);
    assert.equal(preflight.structuredContent.screenshot, undefined);
    assert.equal(mock.nodes.size, countBeforePreflight);
    assert.equal(operations.at(-1).mutating, false);
    const activated = await client.callTool({ name: "activate_page", arguments: { fileKey: "test-file", pageId: otherPage.id } });
    assert.equal(activated.isError, undefined);
    assert.equal(mock.figma.currentPage.id, otherPage.id);
    Object.defineProperty(mock.figma.root, 'name', { get: () => 'Контекст файла', set: () => { throw new Error('DocumentNode.name is read-only'); } });
    const metadataSet = await client.callTool({ name: "set_file_metadata", arguments: { fileKey: "test-file", name: "Контекст файла", thumbnailNodeId: cover.id } });
    assert.equal(metadataSet.isError, undefined);
    const metadata = await client.callTool({ name: "get_file_metadata", arguments: { fileKey: "test-file" } });
    assert.deepEqual(metadata.structuredContent.result, {
      name: "Контекст файла",
      thumbnailNodeId: cover.id,
      pages: [
        { id: mock.page.id, name: "Страница" },
        { id: otherPage.id, name: "Другая страница" },
      ],
    });
    assert.deepEqual(
      operations.slice(-3).map((operation) => [operation.name, operation.mutating]),
      [["activate_page", true], ["set_file_metadata", true], ["get_file_metadata", false]],
    );
    mock.figma.fileKey = 'test-file';
    mock.figma.root.getPluginData = () => '';
    const writesBeforeCapture = mock.writes.length;
    const captured = await client.callTool({name:'capture_library_template',arguments:{fileKey:'test-file',pageIds:[otherPage.id]}});
    assert.equal(captured.isError,undefined);
    assert.equal(captured.structuredContent.operationStatus,'read');
    const snapshot = captured.structuredContent.result.snapshot;
    snapshot.sourceFileKey = 'different-source';
    const verified = await client.callTool({name:'assemble_library_template',arguments:{fileKey:'test-file',snapshot,mode:'verify'}});
    assert.equal(verified.isError,true);
    assert.match(verified.structuredContent.error,/TEMPLATE_NOT_MANAGED/);
    assert.equal(verified.structuredContent.operationStatus,'not_applied');
    assert.equal(mock.writes.length,writesBeforeCapture);
    assert.deepEqual(operations.slice(-2).map(op=>[op.name,op.mutating]),[['capture_library_template',false],['assemble_library_template',false]]);
  } finally {
    socket?.terminate();
    await client.close();
  }
});
