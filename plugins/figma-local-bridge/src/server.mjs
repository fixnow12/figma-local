import {resolveVariablesInputSchema, resolveVariablesSchema, buildResolveVariablesCode} from './resolve-variables.mjs';
import {resolveResourceKeysInputSchema,resolveResourceKeysSchema,buildResolveResourceKeysCode} from './resolve-resource-keys.mjs';
import {importVariablesInputSchema, importVariablesSchema, buildImportVariablesCode} from './import-variables.mjs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FigmaBridge } from "./bridge.mjs";
import { runToolOperation, toolSuccess as ok, toolFailure as fail } from "./tool-results.mjs";
import {
  cloneNodesInputSchema, cloneNodesSchema, moveNodesInputSchema, moveNodesSchema,
  findAssetsInputSchema, findAssetsSchema, bindVariablesInputSchema, bindVariablesSchema,
  setTextLinksInputSchema, setTextLinksSchema, setReactionsInputSchema, setReactionsSchema,
  activatePageInputSchema, activatePageSchema,
  getFileMetadataInputSchema, getFileMetadataSchema,
  setFileMetadataInputSchema, setFileMetadataSchema,
} from "./operation-schemas.mjs";
import { buildCloneCode, buildMoveCode } from "./scene-operations.mjs";
import { buildFindAssetsCode } from "./asset-catalog.mjs";
import { buildSetTextLinksCode, buildSetReactionsCode } from "./interactions.mjs";
import { buildBindVariablesCode } from "./variable-bindings.mjs";
import { buildActivatePageCode, buildGetFileMetadataCode, buildSetFileMetadataCode } from "./file-context.mjs";
import { setNodeVariableModesInputSchema, setNodeVariableModesSchema, buildSetNodeVariableModesCode } from './node-variable-modes.mjs';
import { getPageSettingsInputSchema, getPageSettingsSchema, setPageSettingsInputSchema, setPageSettingsSchema, buildGetPageSettingsCode, buildSetPageSettingsCode } from './page-settings.mjs';
import { captureLibraryTemplateInputSchema, captureLibraryTemplateSchema, assembleLibraryTemplateInputSchema, assembleLibraryTemplateSchema, buildCaptureLibraryTemplateCode, buildAssembleLibraryTemplateCode } from './library-template.mjs';
import { BrokerClient } from "./broker-client.mjs";
import { runtimeDiagnostics } from "./runtime-info.mjs";
import { exportAssetsInputSchema, exportAssetsSchema, buildExportAssetsCode } from "./export-assets.mjs";
import { catalogInventoryInputSchema, catalogInventorySchema, catalogPageInputSchema, catalogPageSchema, catalogExampleInputSchema, catalogExampleSchema, buildCatalogInventoryCode, buildCatalogPageCode, buildCatalogExampleCode } from './catalog-read.mjs';
import { recreateScreenInputSchema, recreateScreen } from "./reconstruction.mjs";
import {
  inspectSelectionInputSchema,
  inspectSelectionSchema,
  patchNodesInputSchema,
  patchNodesSchema,
  renderScreenInputSchema,
  parseRenderScreenInput,
  useComponentSchema,
  useComponentInputSchema,
  normalizeScreenSpec,
} from "./schemas.mjs";
import {
  buildInspectCode,
  buildPatchCode,
  buildRenderCode,
  buildUseComponentCode,
} from "./figma-code.mjs";

const instructions =
  "Локальный write-путь в Figma через Plugin API. Для вариантов существующего экрана (промо, ошибка, новое состояние) используйте recreate_screen с sourceId и changes: он сохраняет исходную оболочку, размеры и свойства. Для точного воссоздания используйте его без changes. Для дизайна с нуля используйте render_screen, " +
  "для итераций — patch_nodes, для чтения выделения — inspect_selection, для экземпляров — use_component. " +
  "Для подключения и списка файлов используйте get_status. Узлы адресуются стабильным key или id. Не перерисовывайте экран ради точечной правки. " +
  "find_assets находит элементы и ресурсы; clone_nodes копирует готовые блоки; move_nodes переносит и переставляет слои; bind_variables привязывает существующие Variables без изменения их значений. " +
  "set_text_links записывает ссылки в тексте; set_reactions настраивает прототипные переходы; inspect_selection возвращает hyperlinks и reactions. " +
  "activate_page переключает текущую страницу по её точному PAGE ID. get_file_metadata читает имя файла, thumbnail и полный список страниц; set_file_metadata задаёт thumbnail и может проверить уже установленное имя, но не переименовывает файл. " +
  "Перед патчем неизвестного дизайна вызовите inspect_selection. Передавайте выбранный fileKey из get_status во всех вызовах, особенно при переходе от чтения к render_screen. При неоднозначной цели уточните файл у пользователя. Сервер не принимает произвольный JavaScript.";

const bridge = process.env.FIGMA_WS_PORT !== undefined
  ? new FigmaBridge({
      host: process.env.FIGMA_WS_HOST || "127.0.0.1",
      port: Number(process.env.FIGMA_WS_PORT),
      portFallback: false,
    })
  : new BrokerClient();
await bridge.start();

const server = new McpServer(
  { name: "codex-figma-compact", version: "0.3.0" },
  { instructions },
);

server.registerTool("recreate_screen", {
  title: "Воссоздать исходный экран",
  description: "Собирает новый экран по исходнику: полностью читает дерево и создаёт редактируемые слои без clone() и ручного переписывания свойств моделью. Для запроса «почти такой же, но с другими элементами» передайте changes: update свойств, remove, replace блока или append детей по sourceId. Изменения вносятся в план до записи; исходник не меняется. Сохраняет шрифты, paints, изображения, эффекты и Auto Layout. Маски сохраняются редактируемыми слоями с исходным типом и порядком соседей; отдельный SVG маски не требуется. Скрытые ветки исключаются. Неполное чтение, недоступные шрифты, VIDEO, Grid/skew и отражённые контейнеры блокируют сборку. dryRun проверяет итоговый план и новые шрифты без создания. Возвращает ID и PNG; сравнение геометрии с оригиналом выполняется только без changes, с changes проверяются тексты и шрифты сохранённых узлов. Используйте для воссоздания и похожих экранов; render_screen — для дизайна с нуля.",
  inputSchema: recreateScreenInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async input => recreateScreen(bridge, input));

server.registerTool("get_status", {
  title: "Проверить подключение",
  description: "Проверяет соединение, версии и ответ Plugin API без чтения холста. Передайте fileKey из ссылки: execution и diagnostics.ready учитывают именно этот файл. execution показывает responsive, busy и activeOperation (имя, mutating, elapsedMs, timedOut). При PLUGIN_BUSY не повторяйте команды циклом с sleep; блокировка другого файла не блокирует назначение. isActive не является достоверным признаком активной вкладки. В первые пять секунд жизни broker ждёт регистрации целевого файла; без fileKey собирает все файлы. После готового статуса прочитайте назначение через inspect_selection.",
  inputSchema: { fileKey: z.string().min(1).optional().describe("Ключ целевого файла из ссылки пользователя. Проверить его подключение, даже если другие файлы уже подключены.") },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ fileKey }) => {
  try {
    const status = await bridge.status({ fileKey });
    const versions = runtimeDiagnostics(status, { fileKey });
    status.execution = await Promise.all((status.files || []).filter(file => !fileKey || file.fileKey === fileKey)
      .map(async file => {
        if (file.pluginBuild !== versions.expectedPluginBuild) return { fileKey: file.fileKey, responsive: null, code: 'PLUGIN_OUTDATED' };
        try { return await bridge.executionStatus(file.fileKey); }
        catch (error) { return { fileKey: file.fileKey, responsive: false, error: error.message }; }
      }));
    status.diagnostics = runtimeDiagnostics(status, { fileKey });
    if (fileKey) {
      status.target = { fileKey, connected: Boolean(status.files?.some(file => file.fileKey === fileKey)) };
      if (!status.target.connected) {
        const issue = { code: "TARGET_FILE_NOT_CONNECTED", action: "check_target_connection", fileKey,
          message: "Целевой файл пока не зарегистрирован в этом Bridge. Это не доказывает, что плагин закрыт: проверьте адресное чтение назначения; если оно также недоступно, сопоставьте состояние подключения в целевом плагине." };
        status.diagnostics.ready = false;
        status.diagnostics.issues.push(issue);
        status.diagnostics.warnings.push(issue.message);
        if (status.diagnostics.state === "READY" || status.diagnostics.state === "FILE_NOT_CONNECTED") {
          status.diagnostics.state = issue.code;
          status.diagnostics.nextAction = issue.action;
        }
      }
    }
    if (!status.connected && typeof bridge.getPairingReference === "function") {
      status.pairingReference = bridge.getPairingReference();
    }
    return ok({ ...status, operationStatus: "read" });
  } catch (error) { return fail(error); }
});

server.registerTool(
  "render_screen",
  {
    title: "Создать экран",
    description:
      "Создаёт дизайн с нуля из JSON-спеки. spec.nodes — один плоский массив; дочерние слои ссылаются на parentKey. Внутри слоя нет nodes/children. dryRun:true проверяет свойства, раскладку и загрузку шрифтов без записи и PNG; это не визуальная проверка SVG или результата. Не переносит оформление прочитанного исходника автоматически. Для вариантов существующего экрана, добавления промо или ошибки используйте recreate_screen с sourceId и changes; для точечных правок — patch_nodes. Повторный вызов с тем же spec.key заменяет предыдущую версию после успешной сборки, сохраняя посторонние элементы секции; PNG возвращается по умолчанию. applied подтверждает запись, а не сходство с исходником.",
    inputSchema: renderScreenInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = parseRenderScreenInput(input);
      const operation = {
        ...parsed,
        replace: parsed.replace ?? true,
        spec: normalizeScreenSpec(parsed.spec),
      };
      return await runToolOperation(bridge, parsed, buildRenderCode(operation), {
        operationName: "render_screen",
        mutating: !parsed.dryRun,
        screenshotRequested: !parsed.dryRun && parsed.screenshot !== false,
        screenshotNode: (payload) => payload.result?.rootId,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "patch_nodes",
  {
    title: "Изменить узлы",
    description:
      "Проверяет цели, свойства и шрифты всего пакета до записи. Применяет изменения по key или id, включая типографику, textRuns, стили и effects. Известные правки одного файла с общей целью и общим откатом передавайте одним массивом patches; если следующая правка зависит от чтения результата предыдущей, выполняйте их отдельно. Для итоговой проверки свойств и PNG используйте один inspect_selection с detail=full и screenshot=true после пакета. Если отдельное чтение не требуется, передайте screenshotKey корневого экрана: ранее снятый PNG не проверяет append/set. При сбое восстанавливает свойства и сообщает результат отката; append не должен автоматически повторяться.",
    inputSchema: patchNodesInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = patchNodesSchema.parse(input);
      const operation = { ...parsed, ignoreMissing: parsed.ignoreMissing ?? false };
      return await runToolOperation(bridge, parsed, buildPatchCode(operation), {
        operationName: "patch_nodes",
        screenshotRequested: Boolean(parsed.screenshotKey),
        screenshotNode: (payload) => payload.result?.screenshotNodeId,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "inspect_selection",
  {
    title: "Прочитать выделение",
    description:
      "Читает выделение, nodeId или nodeIds: размеры, layout, текст и свойства экземпляров; detail=full добавляет точную типографику, textRuns, paints, effects, стили, Variables и Fill/Hug/Fixed. depth: целое 0–8, maxNodes: целое 1–1000. При coverage.complete=false дочитывайте ветки по nodeId из coverage.unread отдельными вызовами с depth ≤ 8. Опционально прикладывает PNG первого узла. Без fileKey при нескольких подключениях возвращает список файлов и requiresFileKey=true без чтения холста; выберите файл по запросу пользователя и повторите с его fileKey. includeFiles добавляет список подключений и при чтении.",
    inputSchema: inspectSelectionInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  async (input) => {
    try {
      const parsed = inspectSelectionSchema.parse(input);
      const connection = parsed.includeFiles || !parsed.fileKey ? await bridge.status() : null;
      if (connection && !parsed.fileKey && connection.files.length !== 1) {
        return ok({
          bridge: connection,
          connectedFiles: connection.files,
          requiresFileKey: connection.files.length > 1,
          selectionInspected: false,
          nextStep: connection.files.length > 1
            ? "Выберите файл из connectedFiles по ссылке или названию в запросе пользователя и повторите inspect_selection с его fileKey. Если цель не указана, уточните файл у пользователя; наличие выделения не определяет целевой файл."
            : "Откройте нужный файл в Figma Desktop и запустите Figma Desktop Bridge, затем повторите inspect_selection.",
        });
      }
      // Pin the same file for inspection and its screenshot, even if another
      // plugin connects while this request is being processed.
      const fileKey = parsed.fileKey || connection?.files[0]?.fileKey;
      const operation = {
        ...parsed,
        depth: parsed.depth ?? 3,
        maxNodes: parsed.maxNodes ?? 200,
      };
      return await runToolOperation(bridge, { ...parsed, fileKey }, buildInspectCode(operation), {
        operationName: "inspect_selection",
        mutating: false,
        timeout: 10000,
        screenshotRequested: parsed.screenshot,
        screenshotNode: (payload) => payload.result?.selection?.[0]?.id,
        extendPayload: (payload) => {
          if (connection) {
            payload.bridge = connection;
            payload.connectedFiles = connection.files;
          }
        },
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "use_component",
  {
    title: "Создать экземпляр компонента",
    description:
      "Создаёт instance локального COMPONENT/COMPONENT_SET по sourceKey или sourceId либо библиотечного компонента по libraryKey. dryRun импортирует и проверяет источник без создания instance. Родитель задаётся parentKey/parentId; поддержаны variant и componentProperties. При сбое настройки удаляет созданный instance.",
    inputSchema: useComponentInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    try {
      const parsed = useComponentSchema.parse(input);
      return await runToolOperation(bridge, parsed, buildUseComponentCode(parsed), {
        operationName: "use_component",
        mutating: !parsed.dryRun,
        screenshotRequested: !parsed.dryRun && parsed.screenshot,
        screenshotNode: (payload) => payload.result?.id,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

function registerGeneratedTool(name, config, schema, buildCode, { mutating = true } = {}) {
  server.registerTool(name, config, async (input) => {
    try {
      const parsed = schema.parse(input);
      return await runToolOperation(bridge, parsed, buildCode(parsed), {
        operationName: name,
        mutating: (typeof mutating === 'function' ? mutating(parsed) : mutating) && !parsed.dryRun,
        screenshotRequested: parsed.dryRun ? false : parsed.screenshot,
        screenshotNode: (payload) => payload.result?.screenshotNodeId,
      });
    } catch (error) {
      return fail(error);
    }
  });
}

registerGeneratedTool('read_catalog_inventory', {
  title:'Прочитать страницы источника каталога',
  description:'Читает все страницы точно указанного файла; nodeId дополнительно устанавливает область источника. Не переключает страницу и выделение. Контракт результата schemaVersion=1, kind=inventory.',
  inputSchema:catalogInventoryInputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},
},catalogInventorySchema,buildCatalogInventoryCode,{mutating:false});

registerGeneratedTool('scan_catalog_page', {
  title:'Сканировать роли и ресурсы страницы каталога',
  description:'Точное чтение pageId и необязательной подобласти nodeId без переключения страницы. roles и manifest возвращают срезы до 200 записей с fingerprint и nextCursor; resources принимает 1–8 ID из полного manifest и проверяет manifestFingerprint перед чтением опубликованных ключей. Исключает ветки DEPRECATED. Контракт schemaVersion=1.',
  inputSchema:catalogPageInputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},
},catalogPageSchema,buildCatalogPageCode,{mutating:false});

server.registerTool('read_catalog_example', {
  title:'Прочитать пример каталога',
  description:'Полное дерево известного узла на pageId с пагинацией до 200 узлов: childIds, parentId, тексты, оформление, Variable bindings и происхождение экземпляров. includePng прикладывает PNG отдельным image block. Не переключает страницу и выделение. Контракт schemaVersion=1.',
  inputSchema:catalogExampleInputSchema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},
},async input=>{
  try {
    const parsed=catalogExampleSchema.parse(input);
    return await runToolOperation(bridge,parsed,buildCatalogExampleCode(parsed),{
      operationName:'read_catalog_example',mutating:false,
      screenshotRequested:Boolean(parsed.includePng),screenshotNode:payload=>payload.result?.screenshotNodeId,
    });
  } catch(error) {return fail(error);}
});

registerGeneratedTool('capture_library_template', {
  title: 'Запомнить библиотечный шаблон',
  description: 'Читает только явно указанные страницы текущего исходного файла и возвращает переносимый snapshot v2: полное дерево включая скрытые экземпляры, опубликованные ключи ресурсов, точные переопределения. Не меняет холст.',
  inputSchema: captureLibraryTemplateInputSchema,
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true},
}, captureLibraryTemplateSchema, buildCaptureLibraryTemplateCode, {mutating:false});

registerGeneratedTool('assemble_library_template', {
  title: 'Собрать или проверить библиотечный шаблон',
  description: 'apply собирает локальный snapshot v2 в пустом назначении через опубликованные библиотеки без обращения к исходному файлу. verify только читает управляемую структуру и реальные ключи экземпляров. Повторный apply сохраняет Jira-текст; при unknown/partial сначала выполнить verify, не повторять запись автоматически.',
  inputSchema: assembleLibraryTemplateInputSchema,
  annotations: {readOnlyHint:false,destructiveHint:false,idempotentHint:true},
}, assembleLibraryTemplateSchema, buildAssembleLibraryTemplateCode, {mutating:input=>input.mode==='apply'});

registerGeneratedTool("activate_page", {
  title: "Выбрать страницу",
  description: "Переключает текущую страницу по точному PAGE ID и подтверждает результат. Содержимое документа не меняет.",
  inputSchema: activatePageInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, activatePageSchema, buildActivatePageCode);

registerGeneratedTool('get_page_settings', {
  title: 'Прочитать настройки страниц',
  description: 'Читает backgrounds и явные режимы Variables с ключами коллекций и именами режимов. Без pageIds читает все страницы, включая пустые. Не импортирует ресурсы и не меняет холст.',
  inputSchema: getPageSettingsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, getPageSettingsSchema, buildGetPageSettingsCode, { mutating: false });

registerGeneratedTool('set_page_settings', {
  title: 'Настроить фон и режимы страниц',
  description: 'Устанавливает SOLID-фон и явные режимы только выбранных PAGE текущего fileKey. Все цели и режимы проверяются до записи. Коллекция импортируется по anchorVariableKey с проверкой collectionKey; библиотека не меняется. При ошибке откатывает собственные изменения, сохраняет конфликтующие чужие. После unknown читать get_page_settings, не повторять запись.',
  inputSchema: setPageSettingsInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, setPageSettingsSchema, buildSetPageSettingsCode);

registerGeneratedTool('resolve_resource_keys', {
 title:'Проверить библиотечные ключи ресурсов',
 description:'Только читает 1–100 точных variableIds/nodeIds текущего файла через Plugin API. Возвращает стабильные ключи переменных и COMPONENT/COMPONENT_SET; semanticKey отделён от библиотечного key. Не импортирует ресурсы и не меняет холст. Неподтверждённые ID остаются unresolved.',
 inputSchema:resolveResourceKeysInputSchema,
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},
},resolveResourceKeysSchema,buildResolveResourceKeysCode,{mutating:false});

registerGeneratedTool('resolve_variables', {
  title: 'Прочитать точные библиотечные переменные',
  description: 'Читает до 100 переменных по подтверждённым ID и проверяет key, resolvedType, collectionKey и полные режимы коллекций. Не импортирует ресурсы и не меняет файл. Отсутствующие или несовпадающие ресурсы возвращает как unresolved; тайм-аут чтения остаётся ошибкой, а не доказательством отсутствия.',
  inputSchema: resolveVariablesInputSchema,
  annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true},
}, resolveVariablesSchema, buildResolveVariablesCode, {mutating:false});

server.registerTool('get_operation_status', {
 title:'Прочитать сохранённое состояние импорта', description:'Читает журнал операции без обращения к холсту. Не повторяет импорт. settled подтверждает завершение native-вызова; ID требует свежего resolve_variables.',
 inputSchema:{fileKey:z.string().min(1),operationId:z.string().uuid()},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true},
},async input=>{try{if(typeof bridge.operationStatus!=='function')throw Object.assign(Error('Журнал доступен только через broker'),{code:'OPERATION_JOURNAL_UNAVAILABLE',operationStatus:'not_applied',commandSent:false});return ok(await bridge.operationStatus(input));}catch(error){return fail(error);}});

registerGeneratedTool('import_variables', {
  title: 'Импортировать библиотечные переменные',
  description: 'Импортирует до 100 переменных по точным key в заданный fileKey, проверяет resolvedType, необязательный collectionKey и читает фактические destination ID и режимы коллекций. Не меняет значения переменных, слои или исходные библиотеки. Импорт меняет кэш ресурсов файла; при частичной ошибке не удаляет импортированное. complete:true подтверждает весь набор. После тайм-аута сначала get_status этого файла; не повторять вслепую.',
  inputSchema: importVariablesInputSchema,
  annotations: {readOnlyHint:false, destructiveHint:false, idempotentHint:true},
}, importVariablesSchema, buildImportVariablesCode);

registerGeneratedTool('set_node_variable_modes', {
  title: 'Установить режимы переменных узлов',
  description: 'Устанавливает явные режимы существующих Variables на точных FRAME/INSTANCE текущей страницы. До записи проверяет все узлы, anchorVariableKey, collectionKey, единственное modeName и шрифты потомков. До 40 привязок; определения компонентов и значения библиотек не меняет. Точный no-op не вызывает setter. При ошибке откатывает только свои режимы; ответ variableModesVerification содержит прочитанные collectionId/modeId. После unknown/partial сначала inspect_selection.',
  inputSchema: setNodeVariableModesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, setNodeVariableModesSchema, buildSetNodeVariableModesCode);

registerGeneratedTool("get_file_metadata", {
  title: "Прочитать метаданные файла",
  description: "Возвращает текущее имя файла, ID узла thumbnail и упорядоченный список всех PAGE с точными id и name. Файл не меняет.",
  inputSchema: getFileMetadataInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, getFileMetadataSchema, buildGetFileMetadataCode, { mutating: false });

registerGeneratedTool("set_file_metadata", {
  title: "Изменить метаданные файла",
  description: "Задаёт thumbnail по ID и/или проверяет уже установленное имя. Изменение имени через Plugin API не поддержано: несовпадающий name даёт FILE_RENAME_UNSUPPORTED/not_applied до записи thumbnail. Читает итог и безопасно откатывает только свой thumbnail при ошибке.",
  inputSchema: setFileMetadataInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, setFileMetadataSchema, buildSetFileMetadataCode);

registerGeneratedTool("export_assets", {
  title: "Экспортировать иконки и изображения",
  description: "Читает только указанные nodeIds: format=svg возвращает SVG для повторной сборки редактируемых иконок и логотипов; format=images — исходные байты IMAGE-заливок и crop/filters. Не экспортируйте целый экран вместо воссоздания слоёв. Ограничивает объём, сообщает пропуски и ошибки. Холст не меняет.",
  inputSchema: exportAssetsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, exportAssetsSchema, buildExportAssetsCode, { mutating: false });

registerGeneratedTool("set_text_links", {
  title: "Настроить ссылки в тексте",
  description: "Записывает или удаляет гиперссылки URL/NODE в TEXT текущей страницы: весь текст или непересекающиеся диапазоны UTF-16 [start,end). target:null снимает ссылку. Проверяет все цели до записи; при ошибке восстанавливает исходные диапазоны. dryRun проверяет без записи. Возвращает прочитанные hyperlinks; клики в прототипе отдельно не проверяет. Оригиналы компонентов требуют подтверждения и allowComponentChanges.",
  inputSchema: setTextLinksInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, setTextLinksSchema, buildSetTextLinksCode);

registerGeneratedTool("set_reactions", {
  title: "Настроить прототипные переходы",
  description: "Настраивает ON_CLICK/ON_HOVER/ON_PRESS/ON_DRAG с одним действием: NAVIGATE, OVERLAY, SCROLL_TO, URL, BACK, CLOSE. upsert заменяет указанные типы триггеров, сохраняя остальные; replace заменяет весь список, [] очищает. NAVIGATE/OVERLAY ведёт в другой верхнеуровневый FRAME той же страницы, SCROLL_TO — к блоку того же экрана. transition:null — мгновенно, DISSOLVE/SMART_ANIMATE с duration в секундах. Проверяет пакет, откатывает при ошибке, возвращает прочитанные reactions. dryRun без записи; реальные клики не проверяет.",
  inputSchema: setReactionsInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
}, setReactionsSchema, buildSetReactionsCode);

registerGeneratedTool("clone_nodes", {
  title: "Скопировать элементы",
  description: "Клонирует готовые блоки с сохранением оформления и экземпляров. Назначает новые key всем слоям копий, возвращает соответствие sourceId → id. При ошибке удаляет созданные копии. Не копирует определения компонентов и не меняет их внутреннюю структуру.",
  inputSchema: cloneNodesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, cloneNodesSchema, buildCloneCode);

registerGeneratedTool("move_nodes", {
  title: "Переместить элементы",
  description: "Перемещает или переставляет узлы текущей страницы по ID между PAGE/FRAME/SECTION. index — конечная позиция с нуля на каждом шаге пакета. Сохраняет ID; при ошибке восстанавливает родителей, порядок и геометрию. Компоненты и внутреннюю структуру экземпляров не меняет.",
  inputSchema: moveNodesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, moveNodesSchema, buildMoveCode);

registerGeneratedTool("find_assets", {
  title: "Найти элементы и ресурсы",
  description: "Ищет по имени nodes/components на странице или во всём файле, локальные styles/variables и метаданные доступных библиотечных коллекций/переменных. Для библиотечных переменных используйте два шага: сначала kind=library_collections, затем передайте полученный collectionKey в kind=library_variables. Возвращает ID, ключи, свойства и страницы результатов. Не импортирует ресурсы; внешний каталог компонентов недоступен через Plugin API.",
  inputSchema: findAssetsInputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, findAssetsSchema, buildFindAssetsCode, { mutating: false });

registerGeneratedTool("bind_variables", {
  title: "Привязать переменные",
  description: "Привязывает доступные в файле Figma Variables по variableId к поддержанным свойствам слоёв и SOLID-заливкам/обводкам. variableId=null снимает привязку. Проверяет типы до записи, при сбое восстанавливает исходные значения и привязки. allowComponentChanges требует подтверждения пользователя на изменение оригинала компонента.",
  inputSchema: bindVariablesInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, bindVariablesSchema, buildBindVariablesCode);

const transport = new StdioServerTransport();

async function shutdown() {
  await server.close().catch(() => {});
  await bridge.stop().catch(() => {});
}

// StdioClientTransport closes stdin first. The SDK server transport does not
// handle EOF, so an open Bridge socket otherwise keeps this process alive
// until the client's two-second SIGTERM fallback. Close only this MCP session;
// let stdout drain and the event loop finish without forcing process.exit().
process.stdin.once("end", () => { void shutdown(); });

process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

await server.connect(transport);
const onTransportClose = transport.onclose;
transport.onclose = () => { onTransportClose?.(); void bridge.stop(); };
