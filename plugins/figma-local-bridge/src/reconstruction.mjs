import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fileKeyDescription } from "./file-target.mjs";
import { buildInspectCode, buildRenderCode } from "./figma-code.mjs";
import { parseRenderScreenInput, normalizeScreenSpec, publicDesignNodeSchema } from "./schemas.mjs";
import { fidelityFields } from "./fidelity.mjs";
import { toolSuccess, toolFailure } from "./tool-results.mjs";
import { createFontService } from "./font-service.mjs";
import { createOperationTimings } from "./operation-timings.mjs";

const changeSchema = z.object({
  sourceId: z.string().min(1).describe("ID узла внутри исходного экрана из inspect_selection. Изменения применяются только к новой сборке."),
  action: z.enum(["update", "remove", "replace", "append"]),
  set: publicDesignNodeSchema.omit({ type: true, key: true, parentKey: true, order: true }).partial().optional()
    .describe("Для update: только изменённые свойства; остальные сохраняются из исходника."),
  nodes: z.array(publicDesignNodeSchema).min(1).max(200).optional()
    .describe("Для replace/append: новые узлы. parentKey ссылается только на key из этого списка. Без parentKey — корни заменяемого блока или добавляемые дети."),
}).strict().superRefine((value, ctx) => {
  const valid = value.action === "update" ? value.set && Object.keys(value.set).length && !value.nodes
    : value.action === "remove" ? !value.set && !value.nodes : value.nodes && !value.set;
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "update требует set; remove — только sourceId; replace/append требуют nodes" });
});

export const recreateScreenInputSchema = {
  fileKey: z.string().min(1).describe(fileKeyDescription),
  sourceId: z.string().min(1).max(160).describe("ID исходного фрейма или экземпляра. Оригинал остаётся нетронутым; новый экран собирается из свойств исходника без clone()."),
  name: z.string().min(1).max(240).optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  dryRun: z.boolean().optional().describe("Только проверить полное чтение, поддержку свойств и доступность шрифтов, без создания узлов."),
  screenshot: z.boolean().optional(),
  changes: z.array(changeSchema).max(200).optional().describe("Собрать похожий экран с изменениями: обновить свойства, удалить, заменить блок или добавить элементы. Чтение исходника, сборка и проверки выполняются внутри инструмента."),
};

const geometry = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"]);
const containers = new Set(["FRAME", "GROUP", "INSTANCE", "COMPONENT", "COMPONENT_SET"]);
const fields = Object.keys(fidelityFields()).filter(k => !["fillStyleId", "strokeStyleId", "x", "y"].includes(k));
const textFields = ["content", "fontFamily", "fontStyle", "fontSize", "lineHeight", "letterSpacing", "textAlign", "textAutoResize", "textAlignVertical", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent", "listOptions", "listSpacing", "indentation", "textRuns"];

// Recreate the currently resolved appearance, without inheriting a library mode
// from a different parent or creating new library definitions.
function resolved(value) {
  if (Array.isArray(value)) return value.map(resolved);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !["boundVariables", "textStyleId"].includes(k)).map(([k, v]) => [k, resolved(v)]));
}

export function buildReconstructionRead(sourceId, changes = []) {
  return `
const snapshot = await (async () => { ${buildInspectCode({ nodeId: sourceId, detail: "full", depth: 64, maxNodes: 2000 })} })();
const discarded = new Set(${JSON.stringify(changes.filter(change => ["remove", "replace"].includes(change.action)).map(change => change.sourceId))});
const svgAssets = {};
let svgBytes = 0;
const fontErrors = [];
const fonts = new Map();
const fontService = (${createFontService.toString()})(typeof executionControl === "undefined" ? undefined : executionControl);
async function collect(item) {
  if (item.effectiveVisible === false || discarded.has(item.id)) return;
  if (item.fontFamily && item.fontStyle) fonts.set(JSON.stringify([item.fontFamily, item.fontStyle]), { family: item.fontFamily, style: item.fontStyle });
  for (const run of item.textRuns || []) if (run.fontFamily && run.fontStyle) fonts.set(JSON.stringify([run.fontFamily, run.fontStyle]), { family: run.fontFamily, style: run.fontStyle });
  // A mask is not painted on its own: SVG export can be empty, especially
  // inside instances. Read its resolved fill contours without touching it.
  if (item.isMask && ${JSON.stringify([...geometry])}.includes(item.type) && !item.vectorPaths?.length) {
    if (!item.fillGeometry?.length) throw new Error("Не прочитана геометрия маски: " + item.id + " (" + item.name + ")");
    item.vectorPaths = item.fillGeometry;
    // fillGeometry already includes rounded corners.
    item.cornerRadius = 0;
  }
  if (${JSON.stringify([...geometry])}.includes(item.type) && !item.vectorPaths?.length) {
    const node = await figma.getNodeByIdAsync(item.id);
    let svg;
    try { svg = await node.exportAsync({ format: "SVG_STRING", svgOutlineText: true }); }
    catch (error) { throw new Error("Не удалось получить исходный SVG для " + item.id + " (" + item.name + "): " + String(error.message || error)); }
    svgBytes += svg.length * 3;
    if (svg.length > 2000000 || svgBytes > 4000000) throw new Error("Слишком большой объём векторных данных; воссоздайте экран по отдельным блокам.");
    svgAssets[item.id] = svg;
    return;
  }
  for (const child of item.children || []) await collect(child);
}
if (snapshot.coverage.complete) for (const root of snapshot.selection) await collect(root);
for (const font of fonts.values()) {
  try {
    await fontService.load(figma, font, "загрузка исходного шрифта");
  } catch (error) {
    if (["FONT_SERVICE_TIMEOUT", "FONT_SERVICE_PENDING"].includes(error.code)) { error.operationStatus = "not_applied"; throw error; }
    fontErrors.push({ ...font, reason: String(error.message || error) });
  }
  if (typeof executionControl !== "undefined" && executionControl.cancelled) throw new Error("Время операции истекло");
}
return { snapshot, svgAssets, fonts: [...fonts.values()], fontErrors };`;
}

export function compileReconstruction(read, { key, name, changes = [] }) {
  const { snapshot, svgAssets = {}, fontErrors = [] } = read;
  if (!snapshot.coverage?.complete || snapshot.selection?.length !== 1) throw new Error("Исходник прочитан не полностью. Воссоздайте меньший блок; неполная сборка не выполняется.");
  if (fontErrors.length) throw new Error("Не удалось загрузить исходные шрифты: " + fontErrors.map(f => `${f.family} / ${f.style}: ${f.reason}`).join("; ") + ". Восстановите доступность шрифтов в Figma. Замена без явного согласия пользователя запрещена.");
  const root = snapshot.selection[0];
  if (root.effectiveVisible === false) throw new Error("Исходный экран скрыт. Выберите видимый экран.");
  if (!["FRAME", "INSTANCE", "COMPONENT"].includes(root.type)) throw new Error("Для воссоздания выберите фрейм или экземпляр экрана.");
  const discarded = new Set(changes.filter(change => ["remove", "replace"].includes(change.action)).map(change => change.sourceId));
  if (discarded.has(root.id)) throw new Error("Корень экрана нельзя удалить или заменить; меняйте его свойства или дочерние блоки.");
  const visibleIds = new Set();
  const reflectedVectors = new Map();
  let skippedHidden = 0;
  function visible(item, hidden = false) {
    const skip = hidden || item.effectiveVisible === false;
    if (skip) skippedHidden++; else visibleIds.add(item.id);
    if (discarded.has(item.id)) return;
    const t = item.relativeTransform;
    // Reapply a native vector's orthogonal reflection after building it.
    // Skew and reflected containers still need separate support.
    if (!skip && item.type === "VECTOR" && item.vectorPaths?.length && t &&
        t[0][0] * t[1][1] - t[0][1] * t[1][0] < 0 &&
        Math.abs(t[0][0] ** 2 + t[1][0] ** 2 - 1) < 0.001 &&
        Math.abs(t[0][1] ** 2 + t[1][1] ** 2 - 1) < 0.001 &&
        Math.abs(t[0][0] * t[0][1] + t[1][0] * t[1][1]) < 0.001) reflectedVectors.set(item.id, t);
    for (const child of item.children || []) visible(child, skip);
  }
  visible(root);
  const blockers = (snapshot.fidelityWarnings || []).filter(w => visibleIds.has(w.nodeId) && !discarded.has(w.nodeId) && !(w.feature === "affine_transform" && reflectedVectors.has(w.nodeId)));
  if (blockers.length) {
    const names = new Map();
    function index(item) { names.set(item.id, item.name); for (const child of item.children || []) index(child); }
    index(root);
    throw Object.assign(new Error("Сборка остановлена до записи: " + blockers.map(w => `${w.nodeId} (${names.get(w.nodeId)}): ${w.feature}`).join("; ") + ". Видеозаливки и другие неподдержанные свойства не заменяются автоматически."), {
      code: "RECONSTRUCTION_BLOCKED", operationStatus: "not_applied",
      blockers: blockers.map(w => ({ ...w, name: names.get(w.nodeId) })),
      nextStep: "Проверьте blockers. Выберите меньший блок или передайте remove/replace только для изменений, запрошенных пользователем. Повтор без изменения параметров не поможет.",
    });
  }
  const mappings = [], nodes = [];
  function convert(item, parent, index, isRoot = false, sourceParent = null) {
    // Keep only an addressable placeholder for an explicitly removed/replaced
    // branch. Its resources and unsupported properties never reach the new plan.
    if (discarded.has(item.id)) item = { id: item.id, name: item.name, type: "FRAME", bounds: item.bounds,
      rotation: item.rotation, absoluteBoundingBox: item.absoluteBoundingBox, layoutPositioning: item.layoutPositioning, layout: { mode: "NONE" } };
    const nodeKey = isRoot ? key : `${key}:${mappings.length}`;
    const isVector = geometry.has(item.type) && item.vectorPaths?.length > 0;
    const isSvg = geometry.has(item.type) && !isVector;
    const type = isRoot ? "screen" : isSvg ? "svg" : isVector ? "vector" : containers.has(item.type) ? "frame" : { TEXT: "text", RECTANGLE: "rectangle", ELLIPSE: "ellipse", LINE: "line" }[item.type];
    if (!type) throw new Error(`Не поддержан тип ${item.type}: ${item.id}. Сборка остановлена до записи.`);
    if (!discarded.has(item.id) && !(item.bounds.width > 0 && (item.bounds.height > 0 || type === "line" && item.bounds.height === 0))) throw new Error(`Нулевой размер узла ${item.id}; точное воссоздание не поддержано.`);
    const out = { key: nodeKey, name: isRoot ? name || `${item.name} — воссоздание` : item.name, type, width: item.bounds.width, height: item.bounds.height };
    if (!isRoot) { out.parentKey = parent.key; out.order = index; }
    if (isSvg) {
      if (!svgAssets[item.id]) throw new Error(`Нет исходного SVG для ${item.id}; подмена иконки запрещена.`);
      out.svg = svgAssets[item.id];
      // SVG already contains paints, effects and opacity. Applying them twice
      // changes the appearance. Only visibility and placement belong outside.
      if (item.visible !== undefined) out.visible = item.visible;
      if (item.layoutPositioning !== undefined) out.layoutPositioning = item.layoutPositioning;
    } else {
      for (const field of [...fields, "opacity", "visible", "effects"]) if (item[field] !== undefined && item[field] !== "MIXED") out[field] = resolved(item[field]);
      if (["frame", "screen", "rectangle", "vector"].includes(type) && typeof item.cornerRadius === "number") out.cornerRadius = item.cornerRadius;
      if (["frame", "screen", "rectangle", "ellipse", "line", "vector"].includes(type) && typeof item.strokeWidth === "number") out.strokeWidth = item.strokeWidth;
      if (["line", "vector"].includes(type)) for (const f of ["strokeCap", "strokeJoin"]) if (item[f] !== undefined) out[f] = item[f];
      if (isVector) out.vectorPaths = item.vectorPaths;
      if (["frame", "screen"].includes(type)) {
        out.clipContent = item.clipContent ?? false;
        const layout = item.layout || { mode: "NONE" };
        const aligns = { MIN: "start", MAX: "end", CENTER: "center", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };
        out.layout = { direction: { NONE: "none", HORIZONTAL: "horizontal", VERTICAL: "vertical" }[layout.mode] };
        if (!out.layout.direction) throw new Error(`Не поддержана раскладка ${layout.mode}: ${item.id}`);
        if (layout.mode !== "NONE") {
          const [top, right, bottom, left] = layout.padding;
          Object.assign(out.layout, { gap: layout.gap, padding: { top, right, bottom, left }, primaryAlign: aligns[layout.primaryAlign], counterAlign: aligns[layout.counterAlign], wrap: layout.wrap === "WRAP" });
          for (const f of ["counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex"]) if (layout[f] !== undefined) out.layout[f] = layout[f];
        }
      }
      if (type === "text") {
        for (const f of textFields) if (item[f] !== undefined) out[f] = resolved(item[f]);
        // A mixed text node needs an explicit base font; never fall back to Inter.
        out.fontFamily ||= item.textRuns?.[0]?.fontFamily;
        out.fontStyle ||= item.textRuns?.[0]?.fontStyle;
        if (!out.fontFamily || !out.fontStyle) throw new Error(`Не прочитан исходный шрифт: ${item.id}`);
      }
    }
    if (!isRoot && (parent.layout?.direction === "none" || out.layoutPositioning === "ABSOLUTE")) {
      // Figma GROUP children use the group's parent coordinate space. New FRAME
      // children use the frame itself, so remove the group's own translation.
      out.x = item.bounds.x - (sourceParent?.type === "GROUP" ? sourceParent.bounds.x : 0);
      out.y = item.bounds.y - (sourceParent?.type === "GROUP" ? sourceParent.bounds.y : 0);
      if (sourceParent?.type === "GROUP") {
        // GROUP children share the source parent's coordinate system, including
        // its rotation. Transform into the new FRAME's local space exactly once.
        const angle = (sourceParent.rotation || 0) * Math.PI / 180;
        const x = out.x, y = out.y;
        out.x = Math.cos(angle) * x - Math.sin(angle) * y;
        out.y = Math.sin(angle) * x + Math.cos(angle) * y;
        out.rotation = (item.rotation || 0) - (sourceParent.rotation || 0);
      }
    }
    let rebuiltTransform;
    if (reflectedVectors.has(item.id)) {
      const t = reflectedVectors.get(item.id);
      const angle = (sourceParent?.type === "GROUP" ? sourceParent.rotation || 0 : 0) * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle);
      rebuiltTransform = [[c * t[0][0] - s * t[1][0], c * t[0][1] - s * t[1][1], out.x ?? t[0][2]],
        [s * t[0][0] + c * t[1][0], s * t[0][1] + c * t[1][1], out.y ?? t[1][2]]];
    }
    mappings.push({ sourceId: item.id, key: nodeKey, source: item, isSvg, rebuiltTransform, rebuiltRotation: out.rotation, expectedBounds: { ...item.bounds, x: out.x ?? item.bounds.x, y: out.y ?? item.bounds.y } });
    if (!isRoot) nodes.push(out);
    if (!isSvg && !isVector) for (const [i, child] of (item.children || []).entries()) if (visibleIds.has(child.id)) convert(child, out, i, false, item);
    return out;
  }
  const spec = { ...convert(root, null, 0, true), nodes };
  // Root is relocated via section position, never via source coordinates.
  delete spec.layoutPositioning;
  const customization = customizeReconstruction(spec, mappings, changes);
  // Customization may move or rotate a retained reflected vector.
  for (const mapping of mappings) if (mapping.rebuiltTransform) {
    const final = spec.nodes.find(node => node.key === mapping.key);
    const t = mapping.rebuiltTransform;
    const angle = ((final.rotation || 0) - (mapping.rebuiltRotation || 0)) * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle);
    mapping.rebuiltTransform = [[c * t[0][0] + s * t[1][0], c * t[0][1] + s * t[1][1], final.x ?? t[0][2]],
      [-s * t[0][0] + c * t[1][0], -s * t[0][1] + c * t[1][1], final.y ?? t[1][2]]];
  }
  const parsed = parseRenderScreenInput({ spec });
  return { spec: normalizeScreenSpec(parsed.spec), mappings, fonts: read.fonts || [], source: root, skippedHidden, customization };
}

// Transform the in-memory plan before any canvas write. Only IDs captured from
// this source tree can be addressed; new keys are namespaced per reconstruction.
function customizeReconstruction(spec, mappings, changes) {
  const applied = [];
  const specs = () => new Map([spec, ...spec.nodes].map(node => [node.key, node]));
  function subtree(key) {
    const keys = new Set([key]);
    let count;
    do { count = keys.size; for (const node of spec.nodes) if (keys.has(node.parentKey)) keys.add(node.key); } while (count !== keys.size);
    return keys;
  }
  for (const [index, input] of changes.entries()) {
    const change = changeSchema.parse(input);
    const entry = mappings.find(item => item.sourceId === change.sourceId);
    const target = entry && specs().get(entry.key);
    if (!target) throw new Error(`Цель изменения отсутствует в видимом исходнике или уже удалена: ${change.sourceId}`);
    if (change.action === "update") {
      const value = { ...change.set };
      if (value.content !== undefined && target.textRuns?.length && !value.textRuns) {
        throw new Error(`Изменение смешанного текста требует textRuns: ${change.sourceId}`);
      }
      if (value.layout) value.layout = { ...target.layout, ...value.layout };
      // Exact paints inherited from the source take precedence in the renderer.
      // Remove them when a caller explicitly chooses a new shorthand colour.
      if (value.color || value.background || value.fill) delete target.fills;
      if (value.stroke) delete target.strokes;
      if (value.cornerRadius !== undefined) for (const field of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) delete target[field];
      Object.assign(target, value);
      // Turning off Auto Layout freezes the container at its current size.
      // HUG is invalid on a free-layout frame; preserve FILL relative to an
      // unchanged Auto Layout parent, and let explicit dimensions win below.
      if (value.layout?.direction === "none") {
        entry.source = { ...entry.source,
          layoutSizingHorizontal: entry.source.layoutSizingHorizontal === "HUG" ? "FIXED" : entry.source.layoutSizingHorizontal,
          layoutSizingVertical: entry.source.layoutSizingVertical === "HUG" ? "FIXED" : entry.source.layoutSizingVertical };
        // Auto Layout children originally omitted x/y. Freeze their captured
        // positions when that layout is removed; explicit changes win.
        for (const child of spec.nodes.filter(node => node.parentKey === target.key)) {
          const original = mappings.find(mapping => mapping.key === child.key);
          if (!original) continue;
          child.x ??= original.expectedBounds.x;
          child.y ??= original.expectedBounds.y;
        }
      }
      if (value.width !== undefined) entry.source = { ...entry.source, layoutSizingHorizontal: typeof value.width === "number" ? "FIXED" : value.width.toUpperCase() };
      if (value.height !== undefined) entry.source = { ...entry.source, layoutSizingVertical: typeof value.height === "number" ? "FIXED" : value.height.toUpperCase() };
    } else if (change.action === "remove" || change.action === "replace") {
      if (target === spec) throw new Error("Корень экрана нельзя удалить или заменить; меняйте его свойства или дочерние блоки.");
      const removed = subtree(target.key);
      spec.nodes = spec.nodes.filter(node => !removed.has(node.key));
      for (let i = mappings.length - 1; i >= 0; i--) if (removed.has(mappings[i].key)) mappings.splice(i, 1);
    }
    if (change.nodes) {
      if (change.action === "append" && !["screen", "frame"].includes(target.type)) throw new Error(`Добавить детей можно только во фрейм: ${change.sourceId}`);
      const keyMap = new Map(change.nodes.map((node, i) => [node.key, `${spec.key}:change-${index}-${i}`]));
      if (keyMap.size !== change.nodes.length) throw new Error("Повторяющийся key в новых элементах");
      const parentKey = change.action === "append" ? target.key : target.parentKey;
      const roots = change.nodes.filter(node => !node.parentKey);
      if (!roots.length) throw new Error("У новых элементов должен быть корень без parentKey");
      const orderedRoots = [...roots].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const siblings = spec.nodes.filter(node => node.parentKey === parentKey);
      const start = change.action === "replace" ? target.order ?? 0 : Math.max(-1, ...siblings.map(node => node.order ?? 0)) + 1;
      if (change.action === "replace") for (const sibling of siblings) if ((sibling.order ?? 0) > start) sibling.order = (sibling.order ?? 0) + roots.length - 1;
      for (const node of change.nodes) {
        if (["component", "componentSet"].includes(node.type)) throw new Error("В реконструкции используйте обычные фреймы, не определения компонентов");
        if (node.parentKey && !keyMap.has(node.parentKey)) throw new Error(`parentKey должен ссылаться на новый элемент: ${node.parentKey}`);
        const added = { ...node, key: keyMap.get(node.key), parentKey: node.parentKey ? keyMap.get(node.parentKey) : parentKey };
        if (!node.parentKey) {
          added.order = start + orderedRoots.indexOf(node);
          if (change.action === "replace" && orderedRoots[0] === node) for (const f of ["x", "y", "layoutPositioning", "width", "height"]) if (added[f] === undefined && target[f] !== undefined) added[f] = target[f];
        }
        spec.nodes.push(added);
      }
    }
    applied.push({ sourceId: change.sourceId, action: change.action });
  }
  return applied;
}

export function buildReconstructionWrite(compiled, position) {
  const customized = compiled.customization.length > 0;
  const bySpec = new Map();
  const collect = node => { bySpec.set(node.key, node); for (const child of node.children || []) collect(child); };
  collect(compiled.spec);
  const mappings = compiled.mappings.map(({ key, source, sourceId, isSvg, rebuiltTransform, expectedBounds }) => ({ key, sourceId, isSvg, rebuiltTransform, bounds: expectedBounds, absolute: source.absoluteBoundingBox,
    sizingH: source.layoutSizingHorizontal, sizingV: source.layoutSizingVertical,
    rotation: bySpec.get(key)?.rotation, isMask: bySpec.get(key)?.isMask, maskType: bySpec.get(key)?.maskType,
    content: bySpec.get(key)?.content, fontFamily: bySpec.get(key)?.fontFamily, fontStyle: bySpec.get(key)?.fontStyle }));
  const finalizeCode = `
  const entries = ${JSON.stringify(mappings)};
  const byKey = new Map([root, ...root.findAll()].map(n => [n.getPluginData("codex-spec-key"), n]));
  for (const entry of [...entries].reverse()) {
    const node = byKey.get(entry.key);
    if (!node || entry.isSvg) continue;
    for (const [field, value] of [["layoutSizingHorizontal", entry.sizingH], ["layoutSizingVertical", entry.sizingV]]) {
      if (value && field in node && (value !== "FILL" || ["HORIZONTAL", "VERTICAL"].includes(node.parent.layoutMode))) node[field] = value;
    }
  }
  for (const entry of entries) if (entry.rebuiltTransform) {
    const node = byKey.get(entry.key);
    if (node) node.relativeTransform = entry.rebuiltTransform;
  }
`;
  return `
const result = await (async () => { ${buildRenderCode({ spec: compiled.spec, replace: false, position, finalizeCode })} })();
// Everything below is read-only; a failed comparison cannot undo a completed write.
try {
  const root = await figma.getNodeByIdAsync(result.rootId);
  const entries = ${JSON.stringify(mappings)};
  const byKey = new Map([root, ...root.findAll()].map(n => [n.getPluginData("codex-spec-key"), n]));
  const differences = [];
  const rootSizing = { checked: [], skipped: [] };
  const originalRoot = entries[0].absolute;
  const rebuiltRoot = root.absoluteBoundingBox;
  const mapping = [];
  for (const entry of entries) {
    const node = byKey.get(entry.key);
    if (!node) { differences.push({ sourceId: entry.sourceId, property: "missing" }); continue; }
    mapping.push({ sourceId: entry.sourceId, id: node.id, key: entry.key });
    if (node === root) for (const [field, expected] of [["layoutSizingHorizontal", entry.sizingH], ["layoutSizingVertical", entry.sizingV]]) {
      if (!expected) continue;
      // A detached screen lives in a SECTION, so its original parent's FILL
      // relationship cannot be restored. Do not claim that relationship passed.
      if (expected === "FILL" && !["HORIZONTAL", "VERTICAL"].includes(node.parent.layoutMode)) {
        rootSizing.skipped.push({ property: field, reason: "parent-without-auto-layout" });
        continue;
      }
      rootSizing.checked.push(field);
      if (node[field] !== expected) differences.push({ sourceId: entry.sourceId, id: node.id, property: field, expected, actual: node[field] });
    }
    for (const f of ${customized} ? [] : node === root ? ["width", "height"] : ["x", "y", "width", "height"]) {
      if (Math.abs(node[f] - entry.bounds[f]) > 0.5) differences.push({ sourceId: entry.sourceId, id: node.id, property: f, expected: entry.bounds[f], actual: node[f] });
    }
    if (!${customized} && originalRoot && rebuiltRoot && entry.absolute && node.absoluteBoundingBox) for (const f of ["x", "y"]) {
      const expected = entry.absolute[f] - originalRoot[f];
      const actual = node.absoluteBoundingBox[f] - rebuiltRoot[f];
      if (Math.abs(expected - actual) > 0.5) differences.push({ sourceId: entry.sourceId, id: node.id, property: "screen." + f, expected, actual });
    }
    if (entry.rebuiltTransform) for (let row = 0; row < 2; row++) for (let column = 0; column < 3; column++) {
      if (Math.abs(node.relativeTransform[row][column] - entry.rebuiltTransform[row][column]) > 0.001) differences.push({ sourceId: entry.sourceId, id: node.id, property: "relativeTransform" });
    }
    if (entry.rotation !== undefined && Math.abs(((node.rotation - entry.rotation + 540) % 360) - 180) > 0.01) differences.push({ sourceId: entry.sourceId, id: node.id, property: "rotation", expected: entry.rotation, actual: node.rotation });
    for (const f of ["isMask", "maskType"]) if (entry[f] !== undefined && node[f] !== entry[f]) differences.push({ sourceId: entry.sourceId, id: node.id, property: f, expected: entry[f], actual: node[f] });
    if (entry.content !== undefined && node.characters !== entry.content) differences.push({ sourceId: entry.sourceId, id: node.id, property: "content" });
    if (entry.fontFamily && (node.fontName === figma.mixed || node.fontName.family !== entry.fontFamily || node.fontName.style !== entry.fontStyle)) differences.push({ sourceId: entry.sourceId, id: node.id, property: "fontName" });
  }
  result.mapping = mapping;
  result.verification = { status: differences.length ? "differences" : "checked", scope: ${JSON.stringify(customized ? "retained-nodes-text-fonts-and-root-sizing" : "source-geometry-text-fonts-and-root-sizing")}, rootSizing, differences: differences.slice(0, 50), differenceCount: differences.length, pixelParityVerified: false };
} catch (error) { result.verification = { status: "failed", error: String(error.message || error), pixelParityVerified: false }; }
return result;`;
}

export async function recreateScreen(bridge, input) {
  let writeAttempted = false;
  const timing = createOperationTimings('recreate_screen', { scope: 'reconstruction_handler' });
  let targetResolved;
  try {
    const parsed = timing.measureSync('validate', () => z.object(recreateScreenInputSchema).strict().parse(input));
    targetResolved = timing.start('resolveTarget');
    const response = await bridge.runInFile(parsed.fileKey, async target => {
      targetResolved();
      const read = await timing.measure('readSource', () => bridge.execute(buildReconstructionRead(parsed.sourceId, parsed.changes), { ...target, timeout: 20000, operation: { name: "recreate_screen", mutating: false } }));
      const compiled = timing.measureSync('compile', () => compileReconstruction(read.result, { key: `recreated-${randomUUID()}`, name: parsed.name, changes: parsed.changes }));
      const summary = { sourceId: parsed.sourceId, sourceNodes: compiled.mappings.length, skippedHidden: compiled.skippedHidden, fonts: compiled.fonts,
        notes: ["Воссоздаётся видимое состояние экрана; скрытые ветки не включаются. Создаются новые редактируемые слои без clone(). Экземпляры и группы становятся фреймами; связи с библиотекой и Variables заменяются текущими значениями.", "Векторы создаются из исходных контуров, остальные фигуры — через SVG. Пиксельное совпадение требует визуальной проверки."] };
      summary.changes = compiled.customization;
      if (parsed.dryRun) {
        await timing.measure('preflight', () => bridge.execute(buildRenderCode({ spec: compiled.spec, replace: false, dryRun: true }), { ...target, timeout: 20000, operation: { name: "recreate_screen", mutating: false } }));
        return { payload: { ...summary, operationStatus: "read", ready: true } };
      }
      const bounds = compiled.source.absoluteBoundingBox || compiled.source.bounds;
      writeAttempted = true;
      const payload = await timing.measure('write', () => bridge.execute(buildReconstructionWrite(compiled, parsed.position || { x: bounds.x + bounds.width + 80, y: bounds.y }), { ...target, timeout: 30000, operation: { name: "recreate_screen", mutating: true } }));
      Object.assign(payload, summary, { operationStatus: "applied" });
      if (parsed.screenshot === false) return { payload };
      try {
        const image = await timing.measure('screenshot', () => bridge.captureScreenshot(payload.result.rootId, { ...target, scale: 1 }));
        payload.screenshot = { status: "captured" };
        return { payload, image };
      } catch (error) {
        payload.screenshot = { status: "failed", error: error.message };
        payload.warnings = ["Экран создан. Не повторяйте recreate_screen; запросите снимок через inspect_selection по rootId."];
        return { payload };
      }
    }, { requireExplicitFile: true });
    return toolSuccess(response.payload, response.image, timing);
  } catch (error) {
    targetResolved?.('error');
    if (!writeAttempted) error.operationStatus = "not_applied";
    return toolFailure(error, timing);
  }
}
