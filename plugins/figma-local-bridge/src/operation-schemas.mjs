import { z } from "zod";
import { fileKeyDescription } from "./file-target.mjs";

const id = () => z.string().min(1).max(160);
const position = () => z.object({ x: z.number(), y: z.number() }).strict();
const preview = () => ({ screenshot: z.boolean().optional(), screenshotScale: z.number().min(0.5).max(4).optional(), fileKey: id().optional().describe(fileKeyDescription) });

export const activatePageInputSchema = {
  pageId: id().describe("ID страницы PAGE целевого файла"),
  fileKey: id().optional().describe(fileKeyDescription),
};
export const activatePageSchema = z.object(activatePageInputSchema).strict();

export const getFileMetadataInputSchema = {
  fileKey: id().optional().describe(fileKeyDescription),
};
export const getFileMetadataSchema = z.object(getFileMetadataInputSchema).strict();

export const setFileMetadataInputSchema = {
  name: z.string().trim().min(1).max(240).optional().describe("Проверка уже установленного имени файла. Иное имя отклоняется FILE_RENAME_UNSUPPORTED: Plugin API не переименовывает файлы."),
  thumbnailNodeId: id().optional().describe("ID FRAME, COMPONENT, COMPONENT_SET или SECTION для установки thumbnail"),
  fileKey: id().optional().describe(fileKeyDescription),
};
export const setFileMetadataSchema = z.object(setFileMetadataInputSchema).strict().refine(
  input => input.name !== undefined || input.thumbnailNodeId !== undefined,
  "Укажите name для проверки текущего имени и/или thumbnailNodeId для записи thumbnail",
);

export const cloneNodesInputSchema = {
  copies: z.array(z.object({
    sourceId: id(), parentId: id().optional(), key: id(),
    name: z.string().min(1).max(240).optional(),
    index: z.number().int().nonnegative().optional(), position: position().optional(),
  }).strict()).min(1).max(20),
  maxNodes: z.number().int().min(1).max(2000).optional(),
  ...preview(),
};
export const cloneNodesSchema = z.object(cloneNodesInputSchema).strict().superRefine((input, context) => {
  const keys = new Set();
  input.copies.forEach((copy, index) => {
    if (keys.has(copy.key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Ключи копий должны быть уникальны", path: ["copies", index, "key"] });
    keys.add(copy.key);
  });
});

export const moveNodesInputSchema = {
  pageTransfer: z.object({ sourcePageId: id(), targetPageId: id() }).strict().optional().describe("Явный перенос верхнеуровневых FRAME/SECTION между двумя существующими Pages одного файла; требует fileKey и parentId=targetPageId у всех moves"),
  moves: z.array(z.object({
    id: id(), parentId: id().optional(), index: z.number().int().nonnegative().optional(), position: position().optional(),
  }).strict().refine((item) => item.parentId !== undefined || item.index !== undefined || item.position !== undefined, "Укажите parentId, index или position")).min(1).max(100),
  ...preview(),
};
export const moveNodesSchema = z.object(moveNodesInputSchema).strict().refine(
  (input) => new Set(input.moves.map((item) => item.id)).size === input.moves.length,
  "Каждый узел может перемещаться только один раз в пакете",
).superRefine((input, context) => {
  if (!input.pageTransfer) return;
  if (!input.fileKey || input.pageTransfer.sourcePageId === input.pageTransfer.targetPageId || input.moves.some(item => item.parentId !== input.pageTransfer.targetPageId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pageTransfer требует fileKey, разные sourcePageId/targetPageId и parentId=targetPageId у всех moves" });
  }
});

export const findAssetsInputSchema = {
  kind: z.enum(["nodes", "components", "styles", "variables", "library_collections", "library_variables"])
    .describe("Тип ресурса. Для library_variables сначала запросите library_collections и возьмите collectionKey из результата."),
  query: z.string().max(240).optional(),
  scope: z.enum(["page", "file"]).optional(),
  types: z.array(z.enum(["FRAME", "SECTION", "GROUP", "TEXT", "RECTANGLE", "ELLIPSE", "VECTOR", "INSTANCE", "COMPONENT", "COMPONENT_SET"])).min(1).max(10).optional(),
  collectionKey: id().optional().describe("Обязателен для kind=library_variables; получите его отдельным вызовом kind=library_collections."),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  fileKey: id().optional().describe(fileKeyDescription),
};
export const findAssetsSchema = z.object(findAssetsInputSchema).strict().superRefine((input, context) => {
  if (input.kind === "library_variables" && !input.collectionKey) context.addIssue({ code: z.ZodIssueCode.custom, message: "Для library_variables нужен collectionKey" });
  if (input.kind !== "library_variables" && input.collectionKey) context.addIssue({ code: z.ZodIssueCode.custom, message: "collectionKey используется только для library_variables" });
  if (input.kind !== "nodes" && input.types) context.addIssue({ code: z.ZodIssueCode.custom, message: "types используется только для поиска nodes" });
  if (input.scope && !["nodes", "components"].includes(input.kind)) context.addIssue({ code: z.ZodIssueCode.custom, message: "scope используется только для nodes/components; остальные ресурсы относятся к файлу" });
});

export const bindVariablesInputSchema = {
  bindings: z.array(z.object({
    nodeId: id(),
    field: z.enum(["fills", "strokes", "width", "height", "opacity", "visible", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontSize", "fontFamily", "fontWeight", "lineHeight", "characters"]),
    variableId: id().nullable(),
    start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(),
    paintIndex: z.number().int().nonnegative().optional(),
  }).strict()).min(1).max(100),
  allowComponentChanges: z.boolean().optional(),
  ...preview(),
};
export const bindVariablesSchema = z.object(bindVariablesInputSchema).strict().superRefine((input, context) => {
  const targets = new Set();
  input.bindings.forEach((binding, index) => {
    const paint = ["fills", "strokes"].includes(binding.field);
    if (!paint && binding.paintIndex !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "paintIndex допустим только для fills/strokes", path: ["bindings", index] });
    const range = binding.start !== undefined || binding.end !== undefined;
    if (range && (binding.start === undefined || binding.end === undefined || binding.start >= binding.end || !["fontFamily", "fontWeight", "fontSize", "lineHeight", "fills"].includes(binding.field))) context.addIssue({ code: z.ZodIssueCode.custom, message: "start/end требуют непустой текстовый диапазон поддерживаемого поля", path: ["bindings", index] });
    if (input.bindings.slice(0, index).some(previous => previous.nodeId === binding.nodeId && previous.field === binding.field && (!paint || (previous.paintIndex ?? 0) === (binding.paintIndex ?? 0)) && (previous.start ?? 0) < (binding.end ?? Infinity) && (binding.start ?? 0) < (previous.end ?? Infinity))) context.addIssue({ code: z.ZodIssueCode.custom, message: "Пересекающиеся цели привязок", path: ["bindings", index] });
    const key = JSON.stringify([binding.nodeId, binding.field, paint ? binding.paintIndex ?? 0 : null, binding.start, binding.end]);
    if (targets.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Повторяющаяся цель привязки", path: ["bindings", index] });
    targets.add(key);
  });
});

const linkUrl = () => z.string().min(1).max(4096).url().refine(value => /^(https?:|mailto:|tel:)/i.test(value), "Поддержаны http, https, mailto и tel");
const hyperlinkTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("URL"), value: linkUrl() }).strict(),
  z.object({ type: z.literal("NODE"), value: id() }).strict(),
]);
const interactionOptions = () => ({
  dryRun: z.boolean().optional().describe("Проверить весь пакет без записи"),
  allowComponentChanges: z.boolean().optional(),
  ...preview(),
});
export const setTextLinksInputSchema = {
  links: z.array(z.object({
    nodeId: id(), start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(),
    target: hyperlinkTarget.nullable().describe("null снимает ссылку; без start/end изменяется весь текст"),
  }).strict()).min(1).max(100),
  ...interactionOptions(),
};
export const setTextLinksSchema = z.object(setTextLinksInputSchema).strict().superRefine((input, context) => {
  input.links.forEach((item, index) => {
    const issue = message => context.addIssue({ code: z.ZodIssueCode.custom, message, path: ["links", index] });
    if ((item.start === undefined) !== (item.end === undefined) || (item.start !== undefined && item.start >= item.end)) issue("Укажите start и end вместе; start < end (индексы UTF-16)");
    if (input.links.slice(0, index).some(previous => previous.nodeId === item.nodeId &&
      (previous.start ?? 0) < (item.end ?? Infinity) && (item.start ?? 0) < (previous.end ?? Infinity))) issue("Диапазоны одного текста не должны пересекаться");
  });
});
const transition = z.object({
  type: z.enum(["DISSOLVE", "SMART_ANIMATE"]), duration: z.number().min(0.01).max(10),
  easing: z.object({ type: z.enum(["LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT"]) }).strict(),
}).strict();
const prototypeAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("BACK") }).strict(),
  z.object({ type: z.literal("CLOSE") }).strict(),
  z.object({ type: z.literal("URL"), url: linkUrl() }).strict(),
  z.object({
    type: z.literal("NODE"), navigation: z.enum(["NAVIGATE", "OVERLAY", "SCROLL_TO"]), destinationId: id(),
    transition: transition.nullable().optional(), preserveScrollPosition: z.boolean().optional(), resetScrollPosition: z.boolean().optional(), resetVideoPosition: z.boolean().optional(),
  }).strict(),
]);
const reaction = z.object({
  trigger: z.object({ type: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"]) }).strict(),
  actions: z.array(prototypeAction).min(1).max(1).describe("Одно действие на триггер в этой версии"),
}).strict();
export const setReactionsInputSchema = {
  updates: z.array(z.object({
    nodeId: id(), mode: z.enum(["upsert", "replace"]).optional().describe("upsert заменяет только указанные типы триггеров; replace заменяет весь список, [] очищает"),
    reactions: z.array(reaction).max(10),
  }).strict()).min(1).max(100),
  ...interactionOptions(),
};
export const setReactionsSchema = z.object(setReactionsInputSchema).strict().superRefine((input, context) => {
  const ids = new Set();
  input.updates.forEach((item, index) => {
    const issue = message => context.addIssue({ code: z.ZodIssueCode.custom, message, path: ["updates", index] });
    if (ids.has(item.nodeId)) issue("Каждый узел указывается один раз в пакете");
    ids.add(item.nodeId);
    if (!item.reactions.length && item.mode !== "replace") issue("Для удаления всех переходов укажите mode: replace");
    if (new Set(item.reactions.map(r => r.trigger.type)).size !== item.reactions.length) issue("Типы триггеров одного узла не должны повторяться");
    for (const r of item.reactions) for (const action of r.actions) {
      if (action.navigation === "SCROLL_TO" && action.transition) issue("SCROLL_TO в этой версии поддерживает только мгновенный переход");
      if (action.resetScrollPosition !== undefined && action.preserveScrollPosition !== undefined && action.resetScrollPosition === action.preserveScrollPosition) issue("resetScrollPosition противоречит preserveScrollPosition");
      if (action.navigation !== "NAVIGATE" && action.resetScrollPosition !== undefined) issue("resetScrollPosition применяется только к NAVIGATE");
      if (action.navigation !== "NAVIGATE" && action.preserveScrollPosition !== undefined) issue("preserveScrollPosition применяется только к NAVIGATE");
    }
  });
});
