import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildInspectCode, buildPatchCode, buildRenderCode, buildUseComponentCode } from "../src/figma-code.mjs";
import { buildFindAssetsCode } from "../src/asset-catalog.mjs";
import { normalizeScreenSpec } from "../src/schemas.mjs";
import { createFigmaMock } from "./helpers/figma-mock.mjs";
import { buildCatalogPageCode } from '../src/catalog-read.mjs';

async function executionHandler(figma, globals = {}) {
  const source = await readFile(new URL("../src/figma-plugin/code.js", import.meta.url), "utf8");
  const start = source.indexOf("var executeCodeQueue = Promise.resolve();");
  const end = source.indexOf("\n  // ============================================================================\n  // UPDATE_VARIABLE", start);
  assert.ok(start > 0 && end > start);
  const messages = [];
  const listeners = new Map();
  figma.ui = { postMessage(message) {
    messages.push(message);
    if (message.type === "EXECUTE_CODE_RESULT") listeners.get(message.requestId)?.(message);
  } };
  vm.runInNewContext(source.slice(start, end) + "\n};", {
    figma, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }, ...globals,
  });
  return {
    messages,
    result(id) { return new Promise((resolve) => listeners.set(id, resolve)); },
    run(id, code, timeout = 1000, extra = {}) { return figma.ui.onmessage({ type: "EXECUTE_CODE", requestId: id, code, timeout, ...extra }); },
    async probe() {
      await figma.ui.onmessage({ type: 'GET_EXECUTION_STATUS', requestId: 'probe' });
      return messages.filter(msg => msg.type === 'GET_EXECUTION_STATUS_RESULT').at(-1);
    },
  };
}

test("тайм-аут не освобождает очередь до завершения выполняющегося кода", async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const handler = await executionHandler(mock.figma, { gate, events });
  const timedOut = handler.result("first");
  const first = handler.run("first", 'events.push("first-start"); await gate; if (executionControl.cancelled) throw new Error("Cancelled"); events.push("late-write");', 5);
  const second = handler.run("second", 'events.push("second"); return 2;');
  try {
    assert.equal((await timedOut).operationStatus, "unknown");
    assert.equal((await handler.probe()).busy, true, 'probe не ждёт завершения зависшей операции');
    assert.deepEqual(events, ["first-start"]);
  } finally {
    release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(events, ["first-start", "second"]);
  assert.equal((await handler.probe()).busy, false);
  assert.equal(handler.messages.find((message) => message.requestId === "second" && message.type === "EXECUTE_CODE_RESULT").success, true);
  assert.deepEqual(handler.messages.filter((message) => message.type === "OPERATION_PROGRESS").map((message) => [message.requestId, message.state]), [["first", "queued"], ["second", "queued"], ["first", "running"], ["second", "running"]]);
});

test('outer catalog timeout retains latest phase snapshot while native page load is pending',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  mock.page.loadAsync=()=>gate;
  const handler=await executionHandler(mock.figma);
  const pending=handler.result('catalog');
  const running=handler.run('catalog',buildCatalogPageCode({fileKey:'target',pageId:mock.page.id,mode:'manifest'}),5,
    {operation:{name:'scan_catalog_page',mutating:false}});
  try{
    const result=await pending;
    assert.equal(result.code,'PLUGIN_EXECUTION_TIMEOUT');
    assert.equal(result.operationStatus,'unknown');
    assert.equal(result.catalogDiagnostics.phase,'pageLoad');
    assert.ok(result.catalogDiagnostics.timings.pageLookupMs>=0);
  }finally{release();await running;}
});

test('команда, задержавшаяся до приёма Plugin API, не выполняется после активации вкладки', async () => {
  const mock = createFigmaMock();
  const events = [];
  const handler = await executionHandler(mock.figma, { events, Date: { now: () => 2000 } });
  await handler.run('suspended', 'events.push("late-write"); return 1;', 1000, { expiresAt: 1999 });
  assert.deepEqual(events, []);
  const result = handler.messages.find(msg => msg.type === 'EXECUTE_CODE_RESULT');
  assert.equal(result.operationStatus, 'not_applied');
  assert.equal(result.code,'PLUGIN_QUEUE_EXPIRED');
  assert.equal((await handler.probe()).busy, false);
});

test('ошибка preflight сохраняет структурированную причину и освобождает очередь', async () => {
  const mock = createFigmaMock();
  const details = { operationStatus: 'not_applied', code: 'FONT_LOAD_TIMEOUT',
    nextStep: 'Проверьте доступность шрифта', fileKey: 'guide',
    retryPolicy: 'after_state_change',
    blockers: [{ type: 'font', family: 'Factor IO', style: 'Bold' }], rollbackErrors: [] };
  const handler = await executionHandler(mock.figma, { details });
  await handler.run('preflight', 'throw Object.assign(new Error("Шрифт недоступен"), details);');
  const result = handler.messages.find(message => message.type === 'EXECUTE_CODE_RESULT');
  for (const [key, value] of Object.entries(details)) assert.deepEqual(result[key], value);
  assert.equal(result.success, false);
  assert.equal((await handler.probe()).busy, false);
});

test("сгенерированный патч после тайм-аута на загрузке шрифта не пишет в макет", async () => {
  const mock = createFigmaMock();
  const text = mock.make("TEXT");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  mock.figma.loadFontAsync = () => gate;
  mock.writes.length = 0;
  const handler = await executionHandler(mock.figma);
  const timedOut = handler.result("patch");
  const operation = handler.run("patch", buildPatchCode({ patches: [{ id: text.id, set: { content: "Новый текст" } }], ignoreMissing: false }), 5);
  try {
    assert.equal((await timedOut).operationStatus, "unknown");
  } finally {
    release();
    await operation;
  }
  assert.equal(text.characters, "Текст");
  assert.equal(mock.writes.length, 0);
});

test("просроченная команда в очереди не выполняется позднее", async () => {
  const mock = createFigmaMock();
  let now = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const handler = await executionHandler(mock.figma, { gate, events, Date: { now: () => now } });
  const first = handler.run("first", "await gate; return 1;", 1000);
  const second = handler.run("expired", 'events.push("late-write"); return 2;', 5);
  await Promise.resolve();
  now = 10;
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, []);
  assert.equal(handler.messages.find((message) => message.requestId === "expired" && message.type === "EXECUTE_CODE_RESULT").operationStatus, "not_applied");
  assert.equal(handler.messages.some((message) => message.requestId === "expired" && message.state === "running"), false);
});

for (const stage of ['load', 'list']) test(`зависание службы шрифтов (${stage}) завершается до записи и освобождает очередь`, async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.figma.loadFontAsync = stage === 'load' ? () => gate : async () => { throw new Error('font service failed'); };
  mock.figma.listAvailableFontsAsync = () => gate;
  const handler = await executionHandler(mock.figma, {
    // Compress only the font service budget; retain the outer execution watchdog.
    setTimeout: (fn, ms) => setTimeout(fn, ms === 8000 ? 5 : ms),
  });
  const spec = normalizeScreenSpec({ key: 'cover', name: 'Обложка', type: 'screen', width: 1440, height: 900,
    nodes: [{ type: 'text', key: 'title', name: 'Название', content: 'Layouts & Grid', fontFamily: 'Factor IO', fontStyle: 'Bold' }] });
  const result = handler.result('font');
  const operation = handler.run('font', buildRenderCode({ spec }), 1000);
  try {
    const response = await result;
    assert.equal(response.operationStatus, 'not_applied');
    assert.match(response.error, /Factor IO.*Bold/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await handler.probe()).busy, false);
    assert.equal(mock.figma.currentPage.children.length, 0);
  } finally {
    release([]);
    await operation;
  }
  assert.equal(mock.figma.currentPage.children.length, 0, 'late font completion cannot resume the abandoned render');
});

test('холодный точный шрифт получает один безопасный повтор после подтверждения каталога', async () => {
  const mock = createFigmaMock();
  const requested = { family: 'Factor IO', style: 'Bold' };
  let exactLoads = 0;
  let listings = 0;
  mock.figma.loadFontAsync = async font => {
    if (font.family === requested.family && font.style === requested.style) {
      exactLoads++;
      if (exactLoads === 1) return new Promise(() => {});
    }
  };
  mock.figma.listAvailableFontsAsync = async () => {
    listings++;
    return [{ fontName: requested }];
  };
  const handler = await executionHandler(mock.figma, {
    setTimeout: (fn, ms) => setTimeout(fn, ms === 8000 ? 5 : ms),
  });
  const spec = normalizeScreenSpec({ key: 'cover', name: 'Обложка', type: 'screen', width: 1440, height: 900,
    nodes: [{ type: 'text', key: 'title', name: 'Название', content: 'Layouts & Grid', fontFamily: requested.family, fontStyle: requested.style }] });

  await handler.run('font-recovery', buildRenderCode({ spec, dryRun: true }), 1000);

  const response = handler.messages.find(message => message.requestId === 'font-recovery' && message.type === 'EXECUTE_CODE_RESULT');
  assert.equal(response.success, true);
  assert.equal(response.result.ready, true);
  assert.equal(exactLoads, 2);
  assert.equal(listings, 1);
  assert.equal(mock.figma.currentPage.children.length, 0);
});

test('повтор точного шрифта ограничен одной попыткой и сохраняет запрет неизменённого retry', async () => {
  const mock = createFigmaMock();
  const requested = { family: 'Factor IO', style: 'Bold' };
  let exactLoads = 0;
  let listings = 0;
  mock.figma.loadFontAsync = async font => {
    if (font.family === requested.family && font.style === requested.style) {
      exactLoads++;
      return new Promise(() => {});
    }
  };
  mock.figma.listAvailableFontsAsync = async () => {
    listings++;
    return [{ fontName: requested }];
  };
  const handler = await executionHandler(mock.figma, {
    setTimeout: (fn, ms) => setTimeout(fn, ms === 8000 ? 5 : ms),
  });
  const spec = normalizeScreenSpec({ key: 'cover', name: 'Обложка', type: 'screen', width: 1440, height: 900,
    nodes: [{ type: 'text', key: 'title', name: 'Название', content: 'Layouts & Grid', fontFamily: requested.family, fontStyle: requested.style }] });

  await handler.run('font-retry-limit', buildRenderCode({ spec, dryRun: true }), 1000);

  const response = handler.messages.find(message => message.requestId === 'font-retry-limit' && message.type === 'EXECUTE_CODE_RESULT');
  assert.equal(response.success, false);
  assert.equal(response.operationStatus, 'not_applied');
  assert.equal(response.retryPolicy, 'after_state_change');
  assert.equal(exactLoads, 2);
  assert.equal(listings, 1);
  assert.equal(mock.figma.currentPage.children.length, 0);
});

for (const kind of ['library_collections', 'library_variables', 'variables', 'styles', 'node']) {
  test(`${kind}: зависшее чтение освобождает очередь без позднего продолжения`, async () => {
    const mock = createFigmaMock();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    mock.figma.teamLibrary = {
      getAvailableLibraryVariableCollectionsAsync: () => gate,
      getVariablesInLibraryCollectionAsync: () => gate,
    };
    mock.figma.variables.getLocalVariablesAsync = () => gate;
    mock.figma.getLocalPaintStylesAsync = () => gate;
    mock.figma.getNodeByIdAsync = () => gate;
    const handler = await executionHandler(mock.figma, {
      setTimeout: (fn, ms) => setTimeout(fn, ms === 6000 ? 5 : ms),
    });
    const code = kind === 'node'
      ? buildInspectCode({ nodeId: '1:99', depth: 1, maxNodes: 20 })
      : buildFindAssetsCode({ kind, collectionKey: 'collection' });
    const response = handler.result('read');
    const running = handler.run('read', code, 200);
    try {
      const result = await response;
      assert.equal(result.code, 'FIGMA_READ_TIMEOUT');
      assert.equal(result.operationStatus, 'not_applied');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal((await handler.probe()).busy, false);
      await handler.run('next', 'return 42;');
      assert.equal(handler.messages.find(m => m.requestId === 'next' && m.success).result, 42);
    } finally {
      release([]);
      await running;
    }
    assert.equal(mock.figma.currentPage.children.length, 0);
    assert.equal(handler.messages.filter(m => m.type === 'EXECUTE_CODE_RESULT' && m.requestId === 'read').length, 1);
  });
}

test('probe сообщает имя и возраст выполняющейся операции только своего файла', async () => {
  const mock = createFigmaMock();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = await executionHandler(mock.figma, { gate });
  const running = handler.run('library', 'await gate;', 1000, { operation: { name: 'find_assets', mutating: false } });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const status = await handler.probe();
    assert.equal(status.activeOperation.name, 'find_assets');
    assert.equal(status.activeOperation.mutating, false);
    assert.ok(status.activeOperation.elapsedMs >= 0);
  } finally { release(); await running; }
  assert.equal((await handler.probe()).activeOperation, null);
});

test('late import journal emits ID and settled after timeout while native mutation lock stays busy', async()=>{
 const {buildImportVariablesCode}=await import('../src/import-variables.mjs');
 const mock=createFigmaMock();mock.figma.fileKey='target';let release;
 mock.figma.variables.importVariableByKeyAsync=()=>new Promise(resolve=>{release=resolve;});
 const handler=await executionHandler(mock.figma);
 const timedOut=handler.result('import');
 const operationId='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
 const running=handler.run('import',buildImportVariablesCode({fileKey:'target',variables:[{key:'a'.repeat(40),resolvedType:'FLOAT'}]}),5,{operation:{name:'import_variables',mutating:true,journal:{operationId,fileKey:'target',argsHash:'hash'}}});
 assert.equal((await timedOut).code,'PLUGIN_EXECUTION_TIMEOUT');assert.equal((await handler.probe()).busy,true);
 release({id:'opaque-late-id',key:'a'.repeat(40),resolvedType:'FLOAT'});await running;
 const events=handler.messages.filter(m=>m.type==='OPERATION_JOURNAL_EVENT').map(m=>m.data);
 assert.deepEqual(events.map(e=>e.stage),['native-import','variable-read','settled']);
 assert.equal(events[1].id,'opaque-late-id');assert.equal(events[2].success,false);assert.equal((await handler.probe()).busy,false);
});

test('late component import proves not_applied and never creates an instance after timeout', async()=>{
 const mock=createFigmaMock();mock.figma.fileKey='target';
 const parent=mock.make('FRAME');
 const component=mock.make('COMPONENT',{name:'Button'},null);
 let release,instances=0;
 component.createInstance=()=>{instances++;return mock.make('INSTANCE',{},null);};
 mock.figma.importComponentByKeyAsync=()=>new Promise(resolve=>{release=()=>resolve(component);});
 const handler=await executionHandler(mock.figma);
 const timedOut=handler.result('component');
 const running=handler.run('component',buildUseComponentCode({
   fileKey:'target',libraryKey:'library-button',parentId:parent.id,key:'guide/button',name:'Кнопка',
 }),5,{operation:{name:'use_component',mutating:true,journal:{operationId:'component-op',fileKey:'target',argsHash:'hash'}}});
 const timeout=await timedOut;
 assert.equal(timeout.code,'PLUGIN_EXECUTION_TIMEOUT');
 assert.equal(timeout.operationStatus,'unknown');
 assert.equal((await handler.probe()).busy,true);
 release();await running;
 const events=handler.messages.filter(m=>m.type==='OPERATION_JOURNAL_EVENT').map(m=>m.data);
 assert.deepEqual(events.map(e=>e.stage),['component-import','settled']);
 assert.equal(events.at(-1).success,false);
 assert.equal(events.at(-1).operationStatus,'not_applied');
 assert.equal(events.at(-1).code,'OPERATION_CANCELLED_BEFORE_MUTATION');
 assert.equal(instances,0);
 assert.equal(parent.children.length,0);
 assert.equal((await handler.probe()).busy,false);
});

for(const delayed of [false,true]) test(`sandbox eval receives explicit execution control (${delayed?'late cancellation':'successful import'})`,async()=>{
 const {buildImportVariablesCode}=await import('../src/import-variables.mjs');
 const mock=createFigmaMock();mock.figma.fileKey='sandbox-file';
 const variable={id:'sandbox-variable',key:'a'.repeat(40),resolvedType:'FLOAT',name:'Token',remote:true,variableCollectionId:'collection'};
 const collection={id:'collection',key:'b'.repeat(40),name:'Collection',remote:true,modes:[{modeId:'default',name:'Default'}],defaultModeId:'default'};
 let release,reads=0;
 mock.figma.variables.importVariableByKeyAsync=delayed?()=>new Promise(resolve=>{release=resolve;}):async()=>variable;
 mock.figma.variables.getVariableByIdAsync=async()=>{reads++;return variable;};
 mock.figma.variables.getVariableCollectionByIdAsync=async()=>collection;
 // Figma's sandbox may evaluate code without the caller's lexical environment.
 const isolatedEval=source=>vm.runInNewContext(source,{figma:mock.figma,setTimeout,clearTimeout});
 const handler=await executionHandler(mock.figma,{eval:isolatedEval});
 const response=handler.result('sandbox');
 const running=handler.run('sandbox',buildImportVariablesCode({fileKey:'sandbox-file',variables:[{key:variable.key,resolvedType:'FLOAT'}]}),delayed?5:1000,{operation:{name:'import_variables',mutating:true,journal:{operationId:'sandbox',fileKey:'sandbox-file',argsHash:'hash'}}});
 const result=await response;
 if(delayed){assert.equal(result.code,'PLUGIN_EXECUTION_TIMEOUT');release(variable);}
 else assert.equal(result.success,true);
 await running;
 const events=handler.messages.filter(m=>m.type==='OPERATION_JOURNAL_EVENT').map(m=>m.data);
 assert.deepEqual(events.map(e=>e.stage),delayed?['native-import','variable-read','settled']:['native-import','variable-read','collection-read','verified','settled']);
 assert.equal(events[1].id,variable.id);assert.equal(reads,delayed?0:1);
 assert.equal(events.at(-1).success,!delayed);
});

test('outer catalog timeout preserves a pending full-tree yield and keeps the queue busy until it settles',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const children=Array.from({length:2050},()=>mock.make('RECTANGLE',{},null));
  mock.page.children=children;for(const node of children)node.parent=mock.page;
  let release;
  const handler=await executionHandler(mock.figma,{setTimeout(fn,delay){
    if(delay===0){release=fn;return 0;}
    return setTimeout(fn,delay);
  }});
  const pending=handler.result('yield-timeout');
  const running=handler.run('yield-timeout',buildCatalogPageCode({fileKey:'target',pageId:mock.page.id,mode:'manifest'}),100,
    {operation:{name:'scan_catalog_page',mutating:false}});
  try{
    const result=await pending;
    assert.equal(result.code,'PLUGIN_EXECUTION_TIMEOUT');
    assert.equal(result.operationStatus,'unknown');
    assert.equal(result.success,false);
    assert.equal(result.catalogDiagnostics.phase,'fullTree');
    assert.equal(result.catalogDiagnostics.counts.treeNodesVisited,2048);
    assert.equal(result.catalogDiagnostics.counts.treeYieldPending,1);
    assert.ok(Number.isFinite(result.catalogDiagnostics.counts.treeYieldStartedAtMs));
    assert.equal((await handler.probe()).busy,true);
  }finally{release?.();await running;}
  assert.equal((await handler.probe()).busy,false);
});
