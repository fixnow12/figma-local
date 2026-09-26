import { createFontService } from "./font-service.mjs";
import { createReadService } from "./read-service.mjs";
import { createMutationSafety } from "./mutation-safety.mjs";
import { createFidelityRuntime } from "./fidelity.mjs";
import { applyExactParagraphRanges } from "./text-paragraphs.mjs";

const DATA_KEY = "codex-spec-key";

function literal(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized.replaceAll("</", "<\\/");
}

function declaredSvgSize(svg) {
  const opening = svg.replace(/<!--[\s\S]*?-->/g, "").match(/<svg(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/);
  if (!opening) return null;
  const attributes = {};
  for (const match of opening[0].matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = match[2] ?? match[3];
  }
  // CSS and relative/unit-based sizes need Figma's importer; do not guess them.
  if (attributes.style !== undefined) return null;
  const pixels = value => {
    if (value === undefined || !/^\s*(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px)?\s*$/i.test(value)) return null;
    const number = parseFloat(value);
    return number > 0 && Number.isFinite(number) ? number : null;
  };
  const width = pixels(attributes.width);
  const height = pixels(attributes.height);
  if (width && height) return { width, height };
  if (attributes.width !== undefined || attributes.height !== undefined) return null;
  const viewBox = attributes.viewBox?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return null;
}

const helpers = `
const DATA_KEY = ${JSON.stringify(DATA_KEY)};
const applyExactParagraphRanges = ${applyExactParagraphRanges.toString()};
const declaredSvgSize = ${declaredSvgSize.toString()};
const operationPage = figma.currentPage;
const fidelity = (${createFidelityRuntime.toString()})(figma);
function checkOperation() {
  if (typeof executionControl !== "undefined" && executionControl.cancelled) {
    const error = new Error("Время операции истекло до изменения макета");
    error.code = "OPERATION_CANCELLED_BEFORE_MUTATION";
    error.operationStatus = "not_applied";
    error.commandSent = true;
    throw error;
  }
}
const readService = (${createReadService.toString()})(figma, checkOperation);

function rgba(hex) {
  const raw = hex.replace("#", "");
  const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return {
    color: {
      r: parseInt(raw.slice(0, 2), 16) / 255,
      g: parseInt(raw.slice(2, 4), 16) / 255,
      b: parseInt(raw.slice(4, 6), 16) / 255,
    },
    opacity: alpha,
  };
}

function paint(hex) {
  const value = rgba(hex);
  return { type: "SOLID", color: value.color, opacity: value.opacity };
}

function paddingValues(value) {
  if (typeof value === "number") {
    return { top: value, right: value, bottom: value, left: value };
  }
  return { top: 0, right: 0, bottom: 0, left: 0, ...(value || {}) };
}

function setIfChanged(node, field, value) {
  if (!(field === "fills" || field === "strokes" ? fidelity.samePaints : sameValue)(node[field], value)) node[field] = value;
}
function applyLayout(node, value) {
  if (!("layoutMode" in node)) return;
  const layout = value || { direction: "vertical", gap: 0, padding: 0 };
  setIfChanged(node, "layoutMode", layout.direction === "none" ? "NONE" : layout.direction === "horizontal" ? "HORIZONTAL" : "VERTICAL");
  const padding = paddingValues(layout.padding || 0);
  setIfChanged(node, "paddingTop", padding.top);
  setIfChanged(node, "paddingRight", padding.right);
  setIfChanged(node, "paddingBottom", padding.bottom);
  setIfChanged(node, "paddingLeft", padding.left);
  setIfChanged(node, "itemSpacing", layout.gap || 0);
  setIfChanged(node, "primaryAxisAlignItems", {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    "space-between": "SPACE_BETWEEN",
  }[layout.primaryAlign || "start"]);
  setIfChanged(node, "counterAxisAlignItems", {
    start: "MIN",
    center: "CENTER",
    end: "MAX",
    baseline: "BASELINE",
  }[layout.counterAlign || "start"]);
  if (node.layoutMode === "NONE") {
    // Native spacing/alignment remains editable while Auto Layout is disabled.
    // These mode-dependent controls do not: accept only captured exact no-ops.
    const inactive = { wrap: "layoutWrap", counterAxisSpacing: "counterAxisSpacing", strokesIncludedInLayout: "strokesIncludedInLayout", itemReverseZIndex: "itemReverseZIndex" };
    for (const [field, property] of Object.entries(inactive)) if (layout[field] !== undefined && node[property] !== (field === "wrap" ? layout.wrap ? "WRAP" : "NO_WRAP" : layout[field])) throw new Error("Сначала включите Auto Layout: " + node.name + " (" + field + " отличается от текущего значения)");
    return;
  }
  if ("layoutWrap" in node) setIfChanged(node, "layoutWrap", layout.wrap ? "WRAP" : "NO_WRAP");
  for (const field of ["counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex"]) if (layout[field] !== undefined) setIfChanged(node, field, layout[field]);
}

function applyVisual(node, item) {
  if (item.opacity !== undefined) node.opacity = item.opacity;
  if (item.visible !== undefined) node.visible = item.visible;
  const fill = item.background || item.fill;
  if (fill && "fills" in node) node.fills = [paint(fill)];
  if (item.stroke && "strokes" in node) node.strokes = [paint(item.stroke)];
  if (item.strokeWidth !== undefined && "strokeWeight" in node) node.strokeWeight = item.strokeWidth;
  if (item.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = item.cornerRadius;
  if (item.clipContent !== undefined && "clipsContent" in node) node.clipsContent = item.clipContent;
}

function applyDimension(node, axis, value) {
  if (value === undefined) return;
  const field = axis === "width" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  if (value === "fill") {
    if (field in node) setIfChanged(node, field, "FILL");
    return;
  }
  if (value === "hug") {
    if (field in node) setIfChanged(node, field, "HUG");
    return;
  }
  if (field in node) setIfChanged(node, field, "FIXED");
  if (node[axis] !== value) {
    if (axis === "width") node.resize(value, node.height);
    else node.resize(node.width, value);
  }
}

function sizeSvg(node, item) {
  const ratio = typeof item.width === "number" ? item.width / node.width : typeof item.height === "number" ? item.height / node.height : 1;
  if (typeof item.width === "number" && typeof item.height === "number" && Math.abs(node.height * ratio - item.height) > 0.1) {
    throw new Error("SVG требует пропорциональные размеры: " + item.name);
  }
  if (ratio !== 1) node.rescale(ratio);
}

const fontLoads = new Map();
let availableFonts;
const fontService = (${createFontService.toString()})();
async function waitForFontService(promise, font, stage) {
  const result = await fontService.wait(promise, font, stage);
  checkOperation();
  return result;
}
function fontLoadFailure(font, detail, cause) {
  return new Error("Недоступен шрифт для загрузки «" + font.family + " / " + font.style + "». " + detail +
    " Причина Figma: " + String(cause && cause.message || cause).slice(0, 500) +
    ". Сохраните исходное семейство и начертание. Не заменяйте шрифт на Inter, Regular или другой шрифт и не повторяйте запись с заменой без явного согласия пользователя. " +
    "Сообщите пользователю имя шрифта и причину; предложите восстановить его доступность в Figma либо согласовать конкретную замену.");
}
async function loadExactFont(font) {
  const key = JSON.stringify(font);
  if (!fontLoads.has(key)) fontLoads.set(key, (async () => {
    try {
      await waitForFontService(figma.loadFontAsync(font), font, "загрузка");
      return font;
    } catch (error) {
      const initialTimeout = error.code === "FONT_SERVICE_TIMEOUT";
      checkOperation();
      // Accept spelling differences only, never substitute another weight/family.
      if (typeof figma.listAvailableFontsAsync !== "function") {
        if (initialTimeout) throw error;
        throw fontLoadFailure(font, "Проверка списка доступных шрифтов не поддерживается; отсутствие шрифта не подтверждено.", error);
      }
      let fonts;
      try {
        availableFonts ||= figma.listAvailableFontsAsync();
        fonts = await waitForFontService(availableFonts, font, "список доступных шрифтов");
      } catch (listingError) {
        if (listingError.code === "FONT_SERVICE_TIMEOUT") throw listingError;
        checkOperation();
        throw fontLoadFailure(font, "Не удалось проверить список шрифтов: " + String(listingError.message || listingError).slice(0, 500) + "; отсутствие шрифта не подтверждено.", error);
      }
      const normalize = value => value.toLowerCase().replace(/[\\s_-]/g, "");
      const matches = fonts.map(item => item.fontName).filter(item =>
        item.family === font.family && normalize(item.style) === normalize(font.style));
      if (matches.length === 1) {
        if (!initialTimeout && matches[0].style === font.style) {
          throw fontLoadFailure(font, "Шрифт есть в списке доступных Figma, но загрузить его не удалось.", error);
        }
        try {
          const stage = initialTimeout ? "повторная загрузка после подтверждения каталога" : "загрузка эквивалентного начертания";
          await waitForFontService(figma.loadFontAsync(matches[0]), matches[0], stage);
        } catch (aliasError) {
          if (aliasError.code === "FONT_SERVICE_TIMEOUT") throw aliasError;
          checkOperation();
          const detail = initialTimeout
            ? "Шрифт подтверждён каталогом, но единственная повторная загрузка также не удалась."
            : "Найдено эквивалентное начертание «" + matches[0].style + "», но его загрузка также не удалась.";
          throw fontLoadFailure(font, detail, aliasError);
        }
        return matches[0];
      }
      throw fontLoadFailure(font, matches.length ? "В списке Figma найдено несколько неоднозначных совпадений начертания." : "В списке доступных Figma нет совпадающего семейства и начертания.", error);
    }
  })());
  return fontLoads.get(key);
}

function textMetric(value) {
  if (typeof value === "number") return { unit: "PIXELS", value };
  return value === "AUTO" ? { unit: "AUTO" } : value;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}

async function styleFont(id) {
  if (!id) return null;
  const style = await figma.getStyleByIdAsync(id);
  if (!style || style.type !== "TEXT") throw new Error("Не найден текстовый стиль: " + id);
  return loadExactFont(style.fontName);
}

const textFields = ["fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent", "listOptions", "listSpacing", "indentation"];
async function applyText(node, item, creating = false, preflightOnly = false) {
  const requested = ["content", "fontFamily", "fontStyle", "fontWeight", "textStyleId", "textRuns", "textAlign", "textAlignVertical", "textAutoResize", "color", ...textFields];
  if (!creating && !requested.some(field => item[field] !== undefined)) return;
  if (node.type !== "TEXT") throw new Error("Типографика поддерживается только для TEXT: " + node.name);
  const content = item.content ?? node.characters;
  for (const field of ["listOptions", "indentation", "listSpacing"]) if (item[field] !== undefined || item.textRuns?.some(r => r[field] !== undefined)) {
    const suffix = field[0].toUpperCase() + field.slice(1);
    if (!content.length || typeof node["setRange" + suffix] !== "function" || typeof node["getRange" + suffix] !== "function") throw new Error("Узел не поддерживает диапазоны " + field);
  }
  const segments = node.characters.length ? node.getStyledTextSegments(["fontName"]) : [];
  const currentFonts = segments.length ? segments.map(segment => segment.fontName) : [node.fontName];
  for (const font of currentFonts) await loadExactFont(font);

  const runs = item.textRuns || [];
  let previousEnd = 0;
  for (const run of runs) {
    if (run.start < previousEnd || run.end <= run.start || run.end > content.length) {
      throw new Error("Диапазоны textRuns должны идти по порядку, не пересекаться и помещаться в текст: " + node.name);
    }
    previousEnd = run.end;
  }
  if (!creating && item.content !== undefined && item.content !== node.characters &&
      node.getStyledTextSegments(["fontName", ...textFields, "textStyleId", "fills"]).length > 1 && !item.textRuns) {
    throw new Error("У текста смешанное оформление. Для замены content передайте textRuns с диапазонами нового текста: " + node.name);
  }
  const fromStyle = await styleFont(item.textStyleId);
  const explicitFont = item.fontFamily !== undefined || item.fontStyle !== undefined || item.fontWeight !== undefined;
  const bases = fromStyle ? [fromStyle] : creating ? [{ family: "Inter", style: "Regular" }] : currentFonts;
  const fonts = await Promise.all(bases.map(font => loadExactFont({
    family: item.fontFamily ?? font.family,
    style: item.fontStyle ?? item.fontWeight ?? font.style,
  })));
  const preparedRuns = [];
  for (const run of runs) {
    const runStyle = await styleFont(run.textStyleId);
    let font = null;
    if (run.fontFamily !== undefined || run.fontStyle !== undefined || run.fontWeight !== undefined) {
      const base = runStyle || fonts[0];
      font = await loadExactFont({ family: run.fontFamily ?? base.family, style: run.fontStyle ?? run.fontWeight ?? base.style });
    }
    preparedRuns.push({ run, font });
  }

  if (preflightOnly) return;
  // All fonts and ranges are validated before changing the text.
  if (item.textStyleId !== undefined) await node.setTextStyleIdAsync(item.textStyleId);
  if ((creating && !item.textStyleId) || explicitFont) {
    if (fonts.every(font => font.family === fonts[0].family && font.style === fonts[0].style)) {
      if (!sameValue(node.fontName, fonts[0])) node.fontName = fonts[0];
    }
    else for (let i = 0; i < segments.length; i++) node.setRangeFontName(segments[i].start, segments[i].end, fonts[i]);
  }
  if (item.content !== undefined) node.characters = item.content;
  for (const field of textFields) {
    if (item[field] !== undefined) {
      const value = ["lineHeight", "letterSpacing"].includes(field) ? textMetric(item[field]) : item[field];
      if (["listOptions", "indentation"].includes(field)) node["setRange" + field[0].toUpperCase() + field.slice(1)](0, content.length, value);
      else if (!sameValue(node[field], value)) node[field] = value;
    }
  }
  if (creating && !item.textStyleId && item.fontSize === undefined) node.fontSize = 14;
  if (item.color !== undefined || (creating && item.fills === undefined && item.fillStyleId === undefined)) node.fills = [paint(item.color || "#111827")];
  if (item.textAlign !== undefined) node.textAlignHorizontal = item.textAlign.toUpperCase();
  if (item.textAlignVertical !== undefined) node.textAlignVertical = item.textAlignVertical;
  if (item.textAutoResize !== undefined) node.textAutoResize = item.textAutoResize;
  for (const { run, font } of preparedRuns) {
    if (run.textStyleId !== undefined) await node.setRangeTextStyleIdAsync(run.start, run.end, run.textStyleId);
    if (font && !sameValue(node.getRangeFontName(run.start, run.end), font)) node.setRangeFontName(run.start, run.end, font);
    for (const field of textFields) if (run[field] !== undefined && !["paragraphSpacing", "paragraphIndent"].includes(field)) {
      const method = "setRange" + field[0].toUpperCase() + field.slice(1);
      const value = ["lineHeight", "letterSpacing"].includes(field) ? textMetric(run[field]) : run[field];
      if (!sameValue(node["getRange" + field[0].toUpperCase() + field.slice(1)](run.start, run.end), value)) node[method](run.start, run.end, value);
    }
  }
  await applyExactParagraphRanges(figma, node, runs);
}

async function applyEffects(node, item) {
  if (item.effects === undefined && item.effectStyleId === undefined) return;
  if (!("effects" in node)) throw new Error("Этот узел не поддерживает эффекты: " + node.name);
  if (item.effectStyleId !== undefined && !sameValue(node.effectStyleId, item.effectStyleId)) await node.setEffectStyleIdAsync(item.effectStyleId);
  if (item.effects !== undefined) {
    const effects = item.effects.map(effect => {
    const value = { ...effect, visible: effect.visible ?? true };
    if (effect.type.endsWith("SHADOW")) {
      if (typeof effect.color === "string") {
        const parsed = rgba(effect.color);
        value.color = { ...parsed.color, a: parsed.opacity };
      }
      value.blendMode = effect.blendMode || "NORMAL";
      value.spread = effect.spread ?? 0;
    }
    return value;
    });
    if (!sameValue(node.effects, effects)) node.effects = effects;
  }
}

let nodesByKey;
function findByKey(key, reuseIndex = false) {
  // Reuse only within synchronous target resolution, before the first await.
  // Append and other conflict checks must see edits made while fonts/API wait.
  let index = nodesByKey;
  if (!reuseIndex || !index) {
    index = new Map();
    for (const node of operationPage.findAll()) {
      const value = node.getPluginData?.(DATA_KEY);
      if (!value || (!reuseIndex && value !== key)) continue;
      if (!index.has(value)) index.set(value, new Map());
      index.get(value).set(node.id, node);
    }
    if (reuseIndex) nodesByKey = index;
  }
  const matches = index.get(key);
  if (matches?.size > 1) throw new Error("Ключ неоднозначен, используйте id: " + key);
  return matches?.values().next().value || null;
}

function variantName(variant, fallback) {
  const entries = Object.entries(variant || {});
  return entries.length ? entries.map(([key, value]) => key + "=" + value).join(", ") : fallback;
}
`;

export function buildRenderCode({ spec, replace, sectionName, position, dryRun = false, finalizeCode = "" }) {
  return `${helpers}
const spec = ${literal(spec)};
const options = ${literal({ replace, sectionName, position, dryRun })};
let createdSection = null;
const created = [];
const previousSelection = [...(operationPage.selection || [])];

async function prepareFonts(item, parent) {
  if (parent && (item.x !== undefined || item.y !== undefined) &&
      parent.type !== "booleanOperation" && parent.layout?.direction !== "none" && item.layoutPositioning !== "ABSOLUTE") {
    throw new Error("x/y требуют свободной раскладки родителя (layout.direction: none) или layoutPositioning: ABSOLUTE: " + item.name);
  }
  await fidelity.validate(item);
  if (item.type === "svg" && typeof item.width === "number" && typeof item.height === "number") {
    const declared = declaredSvgSize(item.svg);
    if (declared && Math.abs(declared.height * item.width / declared.width - item.height) > 0.1) {
      throw new Error("SVG требует пропорциональные размеры: " + item.name);
    }
  }
  if (item.effectStyleId && (await figma.getStyleByIdAsync(item.effectStyleId))?.type !== "EFFECT") {
    throw new Error("Не найден стиль эффектов: " + item.effectStyleId);
  }
  if (item.type === "text") {
    let previousEnd = 0;
    for (const run of item.textRuns || []) {
      if (run.start < previousEnd || run.end <= run.start || run.end > (item.content || "").length) {
        throw new Error("Диапазоны textRuns должны идти по порядку, не пересекаться и помещаться в текст: " + item.name);
      }
      previousEnd = run.end;
    }
    const styleFontName = item.textStyleId ? await styleFont(item.textStyleId) : null;
    const base = styleFontName || { family: "Inter", style: "Regular" };
    const resolvedBase = await loadExactFont({
      family: item.fontFamily ?? base.family,
      style: item.fontStyle ?? item.fontWeight ?? base.style,
    });
    // applyText loads the initial font of a newly created empty TEXT before
    // assigning the requested one. Include that requirement before any nodes.
    await loadExactFont({ family: "Inter", style: "Regular" });
    for (const run of item.textRuns || []) {
      const runStyle = run.textStyleId ? await styleFont(run.textStyleId) : null;
      if (run.fontFamily !== undefined || run.fontStyle !== undefined || run.fontWeight !== undefined) {
        const runBase = runStyle || resolvedBase;
        await loadExactFont({
          family: run.fontFamily ?? runBase.family,
          style: run.fontStyle ?? run.fontWeight ?? runBase.style,
        });
      }
    }
  }
  for (const child of item.children || []) await prepareFonts(child, item);
}

async function build(item, parent, buildOptions = {}) {
  checkOperation();
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await build(child, parent, { deferPosition: true }));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
    created.push(set);
    set.name = item.name;
    set.setPluginData(DATA_KEY, item.key);
    applyLayout(set, item.layout);
    set.clipsContent = item.clipContent ?? false;
    applyVisual(set, item);
    await applyEffects(set, item);
    await fidelity.apply(set, item);
    if (typeof item.width === "number") set.resize(item.width, set.height);
    if (typeof item.height === "number") set.resize(set.width, item.height);
    applyDimension(set, "width", item.width);
    applyDimension(set, "height", item.height);
    fidelity.position(set, item);
    for (let index = 0; index < components.length; index++) {
      fidelity.position(components[index], item.children[index]);
    }
    return set;
  }

  let node;
  if (item.type === "text") {
    node = figma.createText();
    created.push(node);
    parent.appendChild(node);
    await applyText(node, item, true);
    node.textAutoResize = item.textAutoResize ?? (item.width !== undefined && item.width !== "hug" ? "HEIGHT" : "WIDTH_AND_HEIGHT");
  } else if (item.type === "polygon") {
    node = figma.createPolygon();
  } else if (item.type === "star") {
    node = figma.createStar();
  } else if (item.type === "booleanOperation") {
    node = figma.createBooleanOperation();
  } else if (item.type === "rectangle") {
    node = figma.createRectangle();
  } else if (item.type === "line") {
    node = figma.createLine();
    if (item.strokeCap !== undefined) node.strokeCap = item.strokeCap;
    if (item.strokeJoin !== undefined) node.strokeJoin = item.strokeJoin;
  } else if (item.type === "vector") {
    node = figma.createVector();
    created.push(node);
    node.vectorPaths = item.vectorPaths;
    if (item.strokeCap !== undefined) node.strokeCap = item.strokeCap;
    if (item.strokeJoin !== undefined) node.strokeJoin = item.strokeJoin;
  } else if (item.type === "ellipse") {
    node = figma.createEllipse();
  } else if (item.type === "image") {
    node = figma.createRectangle();
    created.push(node);
    const bytes = figma.base64Decode(item.data);
    const image = figma.createImage(bytes);
    node.fills = [{
      type: "IMAGE",
      imageHash: image.hash,
      scaleMode: (item.scaleMode || "fill").toUpperCase(),
    }];
  } else if (item.type === "svg") {
    node = figma.createNodeFromSvg(item.svg);
  } else if (item.type === "component") {
    node = figma.createComponent();
    node.fills = [];
    created.push(node);
    applyLayout(node, item.layout);
    node.clipsContent = item.clipContent ?? false;
  } else {
    node = figma.createFrame();
    node.fills = [];
    created.push(node);
    applyLayout(node, item.layout);
    node.clipsContent = item.clipContent ?? false;
  }

  if (!created.includes(node)) created.push(node);
  node.name = item.type === "component" ? variantName(item.variant, item.name) : item.name;
  node.setPluginData(DATA_KEY, item.key);
  parent.appendChild(node);
  applyVisual(node, item);
  await applyEffects(node, item);
  await fidelity.apply(node, item);

  if (item.type === "svg") sizeSvg(node, item);

  if (typeof item.width === "number") node.resize(item.width, node.height);
  if (typeof item.height === "number") node.resize(node.width, item.height);

  if ("children" in node && Array.isArray(item.children)) {
    for (const child of item.children) await build(child, node);
  }

  applyDimension(node, "width", item.width);
  applyDimension(node, "height", item.height);
  if (!buildOptions.deferPosition) fidelity.position(node, item);
  return node;
}

try {
  const existing = findByKey(spec.key);
  if (existing && !options.replace) {
    throw new Error("Узел с ключом " + spec.key + " уже существует");
  }
  await prepareFonts(spec);
  checkOperation();
  if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки");
  if (options.dryRun) return { ready: true };

  createdSection = figma.createSection();
  created.push(createdSection);
  createdSection.name = options.sectionName || spec.name;
  createdSection.setPluginData(DATA_KEY, "section:" + spec.key);
  const existingSection = existing?.parent?.type === "SECTION" ? existing.parent : null;
  createdSection.x = options.position?.x ?? existingSection?.x ?? existing?.x ?? 0;
  createdSection.y = options.position?.y ?? existingSection?.y ?? existing?.y ?? 0;

  const root = figma.createFrame();
  created.push(root);
  createdSection.appendChild(root);
  root.name = spec.name;
  root.setPluginData(DATA_KEY, spec.key);
  root.resize(spec.width, spec.height);
  applyLayout(root, spec.layout);
  applyVisual(root, spec);
  await applyEffects(root, spec);
  await fidelity.apply(root, spec);

  for (const child of spec.children || []) await build(child, root);
  root.resize(spec.width, spec.height);

  // Internal reconstruction finalization belongs to the same rollback boundary.
  ${finalizeCode}
  checkOperation();
  const result = {
    rootId: root.id,
    sectionId: createdSection.id,
    placement: {
      rootParentId: root.parent?.id || null,
      sectionParentId: createdSection.parent?.id || null,
      destinationParentId: operationPage.id,
      wrapperType: "SECTION",
    },
    key: spec.key,
    nodeCount: root.findAll().length + 1,
    verification: {
      status: "not_checked",
      scope: "source-fidelity",
      pixelParityVerified: false,
      reason: "Создана переданная спецификация. Сравнение с исходным экраном не выполнялось; PNG и отсутствие наложений не подтверждают сходство.",
    },
  };
  if (figma.currentPage === operationPage) {
    operationPage.selection = [root];
    figma.viewport.scrollAndZoomIntoView([createdSection]);
  }

  if (existing) {
    const oldParent = existing.parent;
    if (oldParent?.type === "SECTION" && oldParent.children.length === 1 && oldParent.getPluginData?.(DATA_KEY) === "section:" + spec.key) {
      oldParent.remove();
    } else {
      existing.remove();
    }
  }

  return result;
} catch (error) {
  const rollbackErrors = [];
  for (const node of created.reverse()) {
    try { if (!node.removed) node.remove(); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
  }
  try { if (figma.currentPage === operationPage) operationPage.selection = previousSelection.filter((node) => !node.removed); } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
  error.operationStatus = rollbackErrors.length ? "partial" : created.length ? "rolled_back" : "not_applied";
  error.rollbackErrors = rollbackErrors;
  throw error;
}`;
}

export function buildPatchCode({ patches, ignoreMissing, screenshotKey }) {
  return `${helpers}
const safety = (${createMutationSafety.toString()})(figma, font => waitForFontService(figma.loadFontAsync(font), font, "загрузка исходного шрифта"));
const patches = ${literal(patches)};
const ignoreMissing = ${literal(ignoreMissing)};
const screenshotKey = ${literal(screenshotKey)};
let resolved;
const prepared = [];
const appendKeys = new Set();
let screenshotNodeId = null;
const targetLabel = (patch) => patch.key || patch.id;
try {
resolved = await Promise.all(patches.map(async (patch) => ({
  patch,
  node: patch.key ? findByKey(patch.key, true) : await figma.getNodeByIdAsync(patch.id),
})));
const missing = resolved.filter((item) => !item.node).map((item) => targetLabel(item.patch));
if (missing.length && !ignoreMissing) {
  throw new Error("Не найдены узлы: " + missing.join(", "));
}

// A native scale affects the entire subtree. Overlapping patches would capture
// pre-scale descendant snapshots and make reverse rollback order ambiguous.
const isAncestor = (ancestor, node) => { for (let p = node; p; p = p.parent) if (p === ancestor) return true; return false; };
for (const entry of resolved) {
  if (!entry.node || entry.patch.set?.scaleFactor === undefined || entry.patch.set.scaleFactor === entry.node.scaleFactor) continue;
  if (resolved.some(other => other !== entry && other.node && (isAncestor(entry.node, other.node) || isAncestor(other.node, entry.node)))) throw new Error("Масштабирование экземпляра и пересекающиеся patch требуют отдельных последовательных пакетов");
}

// Resolve capabilities and fonts for the entire batch before the first write.
for (const { patch, node } of resolved) {
  if (!node) continue;
  let page = node;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page !== operationPage) throw new Error("Узел находится на другой странице: " + node.id);
  await fidelity.validate(patch.set || {}, node);
  await applyText(node, patch.set || {}, false, true);
  if (patch.set?.effectStyleId && (await figma.getStyleByIdAsync(patch.set.effectStyleId))?.type !== "EFFECT") throw new Error("Не найден стиль эффектов: " + patch.set.effectStyleId);
  prepared.push({ patch, node, snapshot: await safety.prepare(node, patch.set || {}, patch.append) });
  for (const item of patch.append || []) {
    await fidelity.validate(item);
    if (appendKeys.has(item.key) || findByKey(item.key)) throw new Error("Узел с ключом уже существует: " + item.key);
    appendKeys.add(item.key);
    if (item.type === "text") {
      let previousEnd = 0;
      for (const run of item.textRuns || []) {
        if (run.start < previousEnd || run.end <= run.start || run.end > item.content.length) throw new Error("Диапазоны textRuns должны помещаться в текст: " + item.name);
        previousEnd = run.end;
      }
      const styleFontName = item.textStyleId ? await styleFont(item.textStyleId) : null;
      const base = styleFontName || { family: "Inter", style: "Regular" };
      const resolvedBase = await loadExactFont({
        family: item.fontFamily ?? base.family,
        style: item.fontStyle ?? item.fontWeight ?? base.style,
      });
      for (const run of item.textRuns || []) {
        const runStyle = run.textStyleId ? await styleFont(run.textStyleId) : null;
        if (run.fontFamily !== undefined || run.fontStyle !== undefined || run.fontWeight !== undefined) {
          const runBase = runStyle || resolvedBase;
          await loadExactFont({
            family: run.fontFamily ?? runBase.family,
            style: run.fontStyle ?? run.fontWeight ?? runBase.style,
          });
        }
      }
    }
  }
}
if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки. Повторите чтение макета.");
if (screenshotKey && !appendKeys.has(screenshotKey)) screenshotNodeId = findByKey(screenshotKey)?.id || null;
} catch (error) {
  error.operationStatus = "not_applied";
  throw error;
}
const missing = resolved.filter((item) => !item.node).map((item) => targetLabel(item.patch));
function nestAppendItems(items) {
  const byKey = new Map(items.map((item) => [item.key, { ...item, children: [] }]));
  const roots = [];
  for (const item of items) {
    const copy = byKey.get(item.key);
    if (item.parentKey) {
      const parent = byKey.get(item.parentKey);
      if (!parent) throw new Error("Не найден append parentKey: " + item.parentKey);
      parent.children.push(copy);
    } else {
      roots.push(copy);
    }
  }
  return roots;
}

async function appendNode(item, parent, created) {
  checkOperation();
  if (findByKey(item.key)) throw new Error("Узел с ключом уже существует: " + item.key);
  if (item.type === "componentSet") {
    const components = [];
    for (const child of item.children || []) {
      if (child.type !== "component") throw new Error("Component set может содержать только component-варианты");
      components.push(await appendNode(child, parent, created));
    }
    if (components.length < 2) throw new Error("Component set требует минимум два варианта");
    const set = figma.combineAsVariants(components, parent);
    created.push(set);
    set.name = item.name;
    set.setPluginData(DATA_KEY, item.key);
    applyLayout(set, item.layout);
    set.clipsContent = item.clipContent ?? false;
    applyVisual(set, item);
    await applyEffects(set, item);
    await fidelity.apply(set, item);
    if (typeof item.width === "number") set.resize(item.width, set.height);
    if (typeof item.height === "number") set.resize(set.width, item.height);
    applyDimension(set, "width", item.width);
    applyDimension(set, "height", item.height);
    fidelity.position(set, item);
    return set;
  }

  let node;
  if (item.type === "text") {
    node = figma.createText();
    created.push(node);
    parent.appendChild(node);
    await applyText(node, item, true);
    node.textAutoResize = item.textAutoResize ?? (item.width !== undefined && item.width !== "hug" ? "HEIGHT" : "WIDTH_AND_HEIGHT");
  } else if (item.type === "polygon") {
    node = figma.createPolygon();
  } else if (item.type === "star") {
    node = figma.createStar();
  } else if (item.type === "booleanOperation") {
    node = figma.createBooleanOperation();
  } else if (item.type === "rectangle") {
    node = figma.createRectangle();
  } else if (item.type === "ellipse") {
    node = figma.createEllipse();
  } else if (item.type === "line") {
    node = figma.createLine();
    if (item.strokeCap !== undefined) node.strokeCap = item.strokeCap;
    if (item.strokeJoin !== undefined) node.strokeJoin = item.strokeJoin;
  } else if (item.type === "vector") {
    node = figma.createVector();
    created.push(node);
    node.vectorPaths = item.vectorPaths;
    if (item.strokeCap !== undefined) node.strokeCap = item.strokeCap;
    if (item.strokeJoin !== undefined) node.strokeJoin = item.strokeJoin;
  } else if (item.type === "image") {
    node = figma.createRectangle();
    created.push(node);
    const bytes = figma.base64Decode(item.data);
    const image = figma.createImage(bytes);
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: (item.scaleMode || "fill").toUpperCase() }];
  } else if (item.type === "svg") {
    node = figma.createNodeFromSvg(item.svg);
  } else if (item.type === "component") {
    node = figma.createComponent();
    node.fills = [];
    created.push(node);
    applyLayout(node, item.layout);
    node.clipsContent = item.clipContent ?? false;
  } else {
    node = figma.createFrame();
    node.fills = [];
    created.push(node);
    applyLayout(node, item.layout);
    node.clipsContent = item.clipContent ?? false;
  }

  if (!created.includes(node)) created.push(node);
  node.name = item.type === "component" ? variantName(item.variant, item.name) : item.name;
  node.setPluginData(DATA_KEY, item.key);
  parent.appendChild(node);
  applyVisual(node, item);
  await applyEffects(node, item);
  await fidelity.apply(node, item);
  if (item.type === "svg") sizeSvg(node, item);
  if (typeof item.width === "number") node.resize(item.width, node.height);
  if (typeof item.height === "number") node.resize(node.width, item.height);
  if ("children" in node) {
    for (const child of item.children || []) await appendNode(child, node, created);
  }
  applyDimension(node, "width", item.width);
  applyDimension(node, "height", item.height);
  fidelity.position(node, item);
  return node;
}

const created = [];
const touched = [];
try {
for (const { patch, node, snapshot } of prepared) {
  checkOperation();
  touched.push(snapshot);
  const value = patch.set || {};
  snapshot.applyScale();
  if (value.name !== undefined) setIfChanged(node, "name", value.name);
  await applyText(node, value);
  await applyEffects(node, value);
  if (value.layout !== undefined) {
    applyLayout(node, {
      direction: node.layoutMode === "NONE" ? "none" : node.layoutMode === "HORIZONTAL" ? "horizontal" : "vertical",
      gap: node.itemSpacing,
      padding: { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft },
      primaryAlign: { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "space-between" }[node.primaryAxisAlignItems],
      counterAlign: { MIN: "start", CENTER: "center", MAX: "end", BASELINE: "baseline" }[node.counterAxisAlignItems],
      wrap: node.layoutWrap === "WRAP",
      ...value.layout,
    });
  }
  if (value.visible !== undefined) setIfChanged(node, "visible", value.visible);
  if (value.opacity !== undefined) setIfChanged(node, "opacity", value.opacity);
  if (value.background !== undefined && "fills" in node) setIfChanged(node, "fills", [paint(value.background)]);
  if (value.color !== undefined && node.type === "TEXT") setIfChanged(node, "fills", [paint(value.color)]);
  if (value.stroke !== undefined && "strokes" in node) setIfChanged(node, "strokes", [paint(value.stroke)]);
  if (value.strokeWidth !== undefined && "strokeWeight" in node) setIfChanged(node, "strokeWeight", value.strokeWidth);
  if (value.clipContent !== undefined && "clipsContent" in node) setIfChanged(node, "clipsContent", value.clipContent);
  if (value.cornerRadius !== undefined && "cornerRadius" in node) setIfChanged(node, "cornerRadius", value.cornerRadius);
  if (value.gap !== undefined && "itemSpacing" in node) setIfChanged(node, "itemSpacing", value.gap);
  if (value.padding !== undefined && "paddingTop" in node) {
    const p = paddingValues(value.padding);
    setIfChanged(node, "paddingTop", p.top);
    setIfChanged(node, "paddingRight", p.right);
    setIfChanged(node, "paddingBottom", p.bottom);
    setIfChanged(node, "paddingLeft", p.left);
  }
  if (value.componentProperties !== undefined) {
    if (node.type !== "INSTANCE") throw new Error("componentProperties поддерживается только для INSTANCE: " + node.name);
    node.setProperties(value.componentProperties);
  }
  await fidelity.apply(node, value);
  applyDimension(node, "width", value.width);
  applyDimension(node, "height", value.height);
  fidelity.position(node, value);

  for (const root of nestAppendItems(patch.append || [])) {
    await appendNode(root, node, created);
  }
}
checkOperation();
} catch (error) {
  await safety.rollback(touched, created, error);
}

return {
  status: "applied",
  patched: prepared.map((item) => targetLabel(item.patch)),
  appended: created.filter((node) => !node.removed).map((node) => node.getPluginData(DATA_KEY)),
  missing,
  screenshotNodeId: screenshotNodeId || created.find((node) => !node.removed && node.getPluginData(DATA_KEY) === screenshotKey)?.id || null,
};`;
}

export function buildInspectCode({ nodeId, nodeIds, detail, depth, maxNodes }) {
  return `${helpers}
const nodeId = ${literal(nodeId)};
const nodeIds = ${literal(nodeIds)};
const detail = ${literal(detail)};
const maxDepth = ${literal(depth)};
const maxNodes = ${literal(maxNodes)};
let count = 0;
let truncated = false;
const unread = [];
const assets = [];
const fidelityWarnings = [];
const instanceReads = [];
const siblingTopology = new Map();

function inspect(node, level) {
  const parentId = node.parent?.id || null;
  if (!siblingTopology.has(parentId)) {
    const ids = node.parent?.children?.map(child => child.id) || [];
    siblingTopology.set(parentId, { ids, indices: new Map(ids.map((id, index) => [id, index])) });
  }
  const topology = siblingTopology.get(parentId);
  const parentChildIds = topology.ids;
  const childIndex = topology.indices.get(node.id) ?? -1;
  if (count >= maxNodes) {
    truncated = true;
    unread.push({ nodeId: node.id, reason: "maxNodes", parentId, childIndex });
    return null;
  }
  count += 1;
  const item = {
    id: node.id,
    parentId, childIndex, ...(level === 0 ? { parentChildIds } : {}),
    key: node.getPluginData?.(DATA_KEY) || null,
    name: node.name,
    type: node.type,
    visible: node.visible,
    bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
  };
  let ancestor = node;
  item.effectiveVisible = true;
  while (ancestor && ancestor.type !== "DOCUMENT") {
    if (ancestor.visible === false) item.effectiveVisible = false;
    ancestor = ancestor.parent;
  }
  if ([...(Array.isArray(node.fills) ? node.fills : []), ...(Array.isArray(node.strokes) ? node.strokes : [])].some(p => p.type === "VIDEO")) fidelityWarnings.push({ nodeId: node.id, feature: "VIDEO", message: "Перенос существующей видеозаливки не поддержан; не заменяйте видео картинкой без запроса пользователя" });
  if (node.layoutMode === "GRID") fidelityWarnings.push({ nodeId: node.id, feature: "GRID", message: "Grid ещё не поддержан render_screen; нельзя молча заменять его вертикальным Auto Layout" });
  if (node.relativeTransform && (Math.abs(node.relativeTransform[0][0] * node.relativeTransform[0][1] + node.relativeTransform[1][0] * node.relativeTransform[1][1]) > 0.001 || node.relativeTransform[0][0] * node.relativeTransform[1][1] - node.relativeTransform[0][1] * node.relativeTransform[1][0] < 0)) fidelityWarnings.push({ nodeId: node.id, feature: "affine_transform", message: "Отражение или skew требует отдельного SVG; rotation недостаточно" });
  if ("fills" in node && node.fills !== figma.mixed) item.fills = node.fills;
  if ("strokes" in node) item.strokes = node.strokes;
  if ("strokeWeight" in node && node.strokeWeight !== figma.mixed) item.strokeWidth = node.strokeWeight;
  if ("cornerRadius" in node && node.cornerRadius !== figma.mixed) item.cornerRadius = node.cornerRadius;
  if ("clipsContent" in node) item.clipContent = node.clipsContent;
  if ("opacity" in node) item.opacity = node.opacity;
  if ("effects" in node) item.effects = node.effects;
  if ("effectStyleId" in node && node.effectStyleId !== figma.mixed) item.effectStyleId = node.effectStyleId;
  if (node.type === "TEXT") {
    item.content = node.characters;
    item.mixedTextProperties = [];
    for (const field of ["fontName", ...textFields, "textStyleId"]) {
      const value = ["listOptions", "indentation"].includes(field) && node.characters.length && typeof node["getRange" + field[0].toUpperCase() + field.slice(1)] === "function"
        ? node["getRange" + field[0].toUpperCase() + field.slice(1)](0, node.characters.length) : node[field];
      if (value === figma.mixed) item.mixedTextProperties.push(field);
      else if (field === "fontName") {
        item.fontFamily = value.family;
        item.fontStyle = value.style;
      } else item[field] = value;
    }
    item.textAlign = node.textAlignHorizontal.toLowerCase();
    item.textAutoResize = node.textAutoResize;
    item.hasMissingFont = node.hasMissingFont;
    const segments = node.getStyledTextSegments(["fontName", ...textFields, "textStyleId", "fills"]);
    // Figma may report mixed node properties even with one resolved segment
    // (for example text in an instance). Keep that segment: it is the only
    // concrete font/paint source for reconstruction.
    const needsRuns = segments.length > 1 || item.mixedTextProperties.length > 0 || node.fills === figma.mixed;
    if (segments.length && needsRuns) item.textRuns = segments.map(segment => ({
      start: segment.start, end: segment.end,
      fontFamily: segment.fontName.family, fontStyle: segment.fontName.style,
      ...Object.fromEntries([...textFields, "textStyleId"].map(field => [field, segment[field]])),
      fills: segment.fills,
    }));
    // Keep raw paints per segment: gradients/variables must not be mistaken for a solid color.
    if (segments.length && needsRuns) item.textRunFills = segments.map(segment => ({ start: segment.start, end: segment.end, fills: segment.fills }));
  }
  if ("reactions" in node) item.reactions = node.reactions;
  if (node.type === "TEXT") item.hyperlinks = node.getStyledTextSegments(["hyperlink"]).filter(segment => segment.hyperlink).map(({ start, end, hyperlink }) => ({ start, end, hyperlink }));
  if (node.type === "INSTANCE") item.componentProperties = node.componentProperties;
  if (node.type === "COMPONENT") item.variantProperties = node.variantProperties;
  if (node.type === "COMPONENT_SET") item.variantGroupProperties = node.variantGroupProperties;
  if (detail === "full") {
    if (node.type === "INSTANCE") {
      instanceReads.push({ node, item });
      item.overrides = node.overrides;
    }
    if ("componentPropertyReferences" in node) item.componentPropertyReferences = node.componentPropertyReferences;
    const serializable = (value) => value === figma.mixed ? "MIXED" : value;
    item.parentId = node.parent?.id || null;
    for (const field of ["opacity", "fills", "strokes", "strokeWeight", "cornerRadius", "clipsContent", "effects", "fillStyleId", "strokeStyleId", "effectStyleId", "boundVariables", "explicitVariableModes", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "minWidth", "maxWidth", "minHeight", "maxHeight", "absoluteBoundingBox", "relativeTransform", "rotation", "constraints", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing", "strokeAlign", "strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight", "dashPattern", "blendMode", "isMask", "maskType", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "vectorPaths", "booleanOperation", "pointCount", "strokeCap", "strokeJoin", "scaleFactor"]) {
      if (field in node) item[field] = serializable(node[field]);
    }
    if (node.isMask && ["BOOLEAN_OPERATION", "STAR", "POLYGON"].includes(node.type)) item.fillGeometry = node.fillGeometry;
    if (node.type === "TEXT") {
      item.textSegments = node.getStyledTextSegments(["fontName", ...textFields, "fills", "textStyleId", "fillStyleId", "boundVariables"]);
      item.typography = {};
      for (const field of ["fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textAutoResize", "textStyleId", "hasMissingFont"]) item.typography[field] = serializable(node[field]);
    }
  }
  if ("layoutMode" in node) {
    item.layout = {
      mode: node.layoutMode,
      gap: node.itemSpacing,
      padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
      ...(detail === "full" ? {
        primaryAlign: node.primaryAxisAlignItems,
        counterAlign: node.counterAxisAlignItems,
        wrap: node.layoutWrap,
        counterAxisSpacing: node.counterAxisSpacing,
        strokesIncludedInLayout: node.strokesIncludedInLayout,
        itemReverseZIndex: node.itemReverseZIndex,
      } : {}),
    };
  }
  if ("children" in node) {
    item.childIds = node.children.map(child => child.id);
    item.childCount = item.childIds.length;
  }
  if (level < maxDepth && "children" in node) {
    item.children = node.children.map((child) => inspect(child, level + 1)).filter(Boolean);
  } else if ("children" in node) {
    item.childCount = node.children.length;
    if (node.children.length) {
      truncated = true;
      unread.push({ nodeId: node.id, reason: "depth", childCount: node.children.length });
    }
  }
  const imageHashes = [...(Array.isArray(node.fills) ? node.fills : []), ...(Array.isArray(node.strokes) ? node.strokes : [])].filter(p => p.type === "IMAGE").map(p => p.imageHash);
  if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"].includes(node.type) || imageHashes.length) assets.push({ nodeId: node.id, type: node.type, imageHashes });
  return item;
}

const requested = nodeIds || (nodeId ? [nodeId] : null);
const roots = requested ? await Promise.all(requested.map((id) => readService.node(id))).catch(error => {
  error.operationStatus = "not_applied";
  throw error;
}) : operationPage.selection;
const selection = roots.filter(Boolean).map((node) => inspect(node, 0)).filter(Boolean);
// Resolve read-only library provenance after the synchronous bounded tree walk.
// No imports or instance mutations; a missing resource must not invent a key.
await Promise.all(instanceReads.map(async ({ node, item }) => {
  try {
    if (typeof node.getMainComponentAsync !== "function") throw new Error("getMainComponentAsync unavailable");
    const component = await readService.wait(node.getMainComponentAsync(), "исходный компонент " + node.id);
    item.mainComponent = component
      ? { status: "resolved", id: component.id, key: component.key, name: component.name, remote: component.remote }
      : { status: "missing" };
  } catch (error) {
    item.mainComponent = { status: "unavailable", message: String(error.message || error), ...(error.code ? { code: error.code } : {}) };
  }
}));
return {
  page: { id: operationPage.id, name: operationPage.name },
  selection,
  missing: requested ? requested.filter((_id, index) => !roots[index]) : [],
  inspectedNodes: count,
  truncated,
  coverage: { complete: !truncated && !roots.some(node => !node), unread, assetNodes: assets },
  fidelityWarnings,
};`;
}

export function buildUseComponentCode(input) {
  return `${helpers}
const input = ${literal(input)};
let component = null;

if (input.sourceKey || input.sourceId) {
  component = input.sourceId ? await figma.getNodeByIdAsync(input.sourceId) : findByKey(input.sourceKey);
  if (!component) throw new Error("Локальный компонент не найден: " + (input.sourceKey || input.sourceId));
} else {
  component = await figma.importComponentByKeyAsync(input.libraryKey);
  if (typeof executionControl !== "undefined" && executionControl.report) {
    executionControl.report({ stage: "component-import", libraryKey: input.libraryKey, id: component?.id });
  }
  checkOperation();
}

if (component?.type === "COMPONENT_SET") {
  const candidates = component.children.filter((node) => node.type === "COMPONENT");
  if (input.variant && Object.keys(input.variant).length) {
    component = candidates.find((candidate) =>
      Object.entries(input.variant).every(([key, value]) => candidate.variantProperties?.[key] === value)
    );
    if (!component) throw new Error("Вариант component set не найден: " + JSON.stringify(input.variant));
  } else {
    component = candidates[0] || null;
  }
}

if (!component || component.type !== "COMPONENT") {
  throw new Error("Источник должен быть COMPONENT или COMPONENT_SET");
}

if (input.dryRun) {
  if (typeof executionControl !== "undefined" && executionControl.report) {
    executionControl.report({ stage: "verified", id: component.id });
  }
  return {
    ready: true,
    sourceId: component.id,
    sourceType: component.type,
    sourceName: component.name,
    libraryKey: input.libraryKey || component.key,
    variantProperties: component.variantProperties,
    componentPropertyDefinitions: (component.parent?.type === "COMPONENT_SET" ? component.parent : component).componentPropertyDefinitions,
  };
}

const parent = input.parentId ? await figma.getNodeByIdAsync(input.parentId) : input.parentKey ? findByKey(input.parentKey) : operationPage;
if (!parent || !["PAGE", "FRAME", "SECTION", "COMPONENT"].includes(parent.type) || !("appendChild" in parent)) {
  throw new Error("Родитель не найден или не поддерживает дочерние узлы: " + input.parentKey);
}

let parentPage = parent;
while (parentPage && parentPage.type !== "PAGE") parentPage = parentPage.parent;
if (parentPage !== operationPage) throw new Error("Родитель находится на другой странице");
if (figma.currentPage !== operationPage) throw new Error("Страница изменилась во время проверки");
checkOperation();
const existing = findByKey(input.key);
if (existing) throw new Error("Узел с ключом " + input.key + " уже существует");

const instance = component.createInstance();
if (typeof executionControl !== "undefined" && executionControl.report) {
  executionControl.report({ stage: "instance-created", id: instance.id });
}
try {
instance.name = input.name || component.name;
instance.setPluginData(DATA_KEY, input.key);
parent.appendChild(instance);
if (typeof executionControl !== "undefined" && executionControl.report) executionControl.report({ stage: "attached", id: instance.id });
if (input.componentProperties) instance.setProperties(input.componentProperties);
if (input.position) {
  instance.x = input.position.x;
  instance.y = input.position.y;
}
if (figma.currentPage === operationPage) {
  operationPage.selection = [instance];
  figma.viewport.scrollAndZoomIntoView([instance]);
}
if (typeof executionControl !== "undefined" && executionControl.report) executionControl.report({ stage: "verified", id: instance.id });
return {
  id: instance.id,
  key: input.key,
  name: instance.name,
  sourceId: component.id,
  parentId: parent.id,
  variantProperties: component.variantProperties,
  componentProperties: instance.componentProperties,
};
} catch (error) {
  try {
    if (!instance.removed) instance.remove();
    error.operationStatus = "rolled_back";
  } catch (rollbackError) {
    error.operationStatus = "partial";
    error.rollbackErrors = [rollbackError.message];
  }
  throw error;
}`;
}

export { DATA_KEY };
