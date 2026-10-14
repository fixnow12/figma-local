import { applyExactParagraphRanges } from "./text-paragraphs.mjs";
// Serialized into Plugin API code. Keep this function self-contained.
export function createMutationSafety(figma, requestFont = font => figma.loadFontAsync(font), applyParagraphRanges = applyExactParagraphRanges) {
  const fonts = new Map();
  function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}
  const fieldMap = {
    ...Object.fromEntries(["fills", "strokes", "isMask", "maskType", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "cornerSmoothing", "strokeAlign", "strokeTopWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeRightWeight", "dashPattern", "blendMode", "rotation", "layoutPositioning", "constraints", "minWidth", "maxWidth", "minHeight", "maxHeight", "textAutoResize", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "listSpacing", "vectorPaths", "booleanOperation", "pointCount", "strokeCap", "strokeJoin"].map(k => [k, k])),
    name: "name", content: "characters", visible: "visible", opacity: "opacity",
    x: "x", y: "y", background: "fills", color: "fills", stroke: "strokes",
    strokeWidth: "strokeWeight", cornerRadius: "cornerRadius", gap: "itemSpacing",
    fontSize: "fontSize", fontFamily: "fontName", fontStyle: "fontName", fontWeight: "fontName",
    lineHeight: "lineHeight", letterSpacing: "letterSpacing", textAlign: "textAlignHorizontal",
    textCase: "textCase", textDecoration: "textDecoration",
    clipContent: "clipsContent", effects: "effects",
  };
  const textFields = ["content", "color", "fontSize", "fontFamily", "fontStyle", "fontWeight", "lineHeight", "letterSpacing", "textAlign", "textCase", "textDecoration", "textStyleId", "textRuns", "textAutoResize", "textAlignVertical", "paragraphSpacing", "paragraphIndent", "listOptions", "listSpacing", "indentation", "fills", "fillStyleId"];
  const layoutFields = ["layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap", "counterAxisSpacing", "strokesIncludedInLayout", "itemReverseZIndex"];
  const copy = (value) => value === undefined || typeof value === "symbol" ? value : JSON.parse(JSON.stringify(value));

  function loadFont(font) {
    const key = JSON.stringify(font);
    if (!fonts.has(key)) fonts.set(key, requestFont(font));
    return fonts.get(key);
  }

  async function prepare(node, value, append) {
    const originalScale = value.scaleFactor !== undefined ? node.scaleFactor : null;
    let scaleChanged = false;
    if (value.scaleFactor !== undefined) {
      if (node.type !== "INSTANCE" || typeof node.rescale !== "function" || !Number.isFinite(value.scaleFactor) || value.scaleFactor <= 0 || !Number.isFinite(originalScale) || originalScale <= 0) throw new Error("scaleFactor требует INSTANCE с положительным конечным нативным масштабом");
      const ratio = value.scaleFactor / originalScale;
      if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 100) throw new Error("scaleFactor: отношение масштабов должно быть от 0.01 до 100 для обратимого native rescale");
      if (!Number.isFinite(node.width * ratio) || !Number.isFinite(node.height * ratio)) throw new Error("Масштабирование превышает конечный размер");
      scaleChanged = value.scaleFactor !== originalScale;
      if (scaleChanged) for (let parent = node.parent; parent; parent = parent.parent) if (parent.type === "INSTANCE") throw new Error("Нельзя менять scaleFactor внутри экземпляра: " + node.id);
      if (scaleChanged) {
        const previousSkip = figma.skipInvisibleInstanceChildren;
        try {
          if (previousSkip === true) figma.skipInvisibleInstanceChildren = false;
          const queue = [node]; let count = 0;
          while (queue.length) {
            if (++count > 2000) throw new Error("Масштабирование требует полного чтения: более 2000 узлов");
            const child = queue.pop();
            if (child.type === "TEXT") {
              const segments = child.characters.length ? child.getStyledTextSegments(["fontName"]) : [];
              const currentFonts = segments.length ? segments.map(segment => segment.fontName) : [child.fontName];
              for (const font of currentFonts) {
                if (!font || font === figma.mixed) throw new Error("Не прочитан шрифт масштабируемого текста: " + child.id);
                await loadFont(font);
              }
            }
            if ("children" in child) queue.push(...child.children);
          }
        } finally { if (previousSkip === true) figma.skipInvisibleInstanceChildren = true; }
      }
    }
    for (const field of Object.keys(value)) {
      if (textFields.includes(field) && !["fills", "fillStyleId"].includes(field) && node.type !== "TEXT") throw new Error(field + " поддерживается только для TEXT: " + node.name);
      const property = fieldMap[field];
      if (property && !(property in node)) throw new Error("Узел не поддерживает " + field + ": " + node.name);
    }
    if (value.padding !== undefined && !("paddingTop" in node)) throw new Error("Узел не поддерживает padding: " + node.name);
    if (value.layout !== undefined && !("layoutMode" in node)) throw new Error("Узел не поддерживает Auto Layout: " + node.name);
    const layoutMode = value.layout?.direction === "none" ? "NONE" : value.layout?.direction ? "AUTO" : node.layoutMode;
    if (layoutMode === "NONE") {
      const inactive = { wrap: "layoutWrap", counterAxisSpacing: "counterAxisSpacing", strokesIncludedInLayout: "strokesIncludedInLayout", itemReverseZIndex: "itemReverseZIndex" };
      for (const [field, property] of Object.entries(inactive)) if (value.layout?.[field] !== undefined) {
        const requested = field === "wrap" ? value.layout.wrap ? "WRAP" : "NO_WRAP" : value.layout[field];
        if (node[property] !== requested) throw new Error("Сначала включите Auto Layout: " + node.name + " (" + field + " отличается от текущего значения)");
      }
    }
    if (append?.length && (!["FRAME", "COMPONENT", "PAGE", "SECTION"].includes(node.type) || !("appendChild" in node))) {
      throw new Error("Нельзя добавлять дочерние узлы в " + node.type + ": " + node.name);
    }
    for (const axis of ["width", "height"]) {
      const dimension = value[axis];
      if (dimension === undefined) continue;
      if (dimension === 0 && !(axis === "height" && ["LINE", "VECTOR"].includes(node.type))) throw new Error("Нулевая высота поддерживается только для LINE/VECTOR");
      if (typeof node.resize !== "function" && !(node.type === "SECTION" && typeof node.resizeWithoutConstraints === "function")) throw new Error("Узел не поддерживает изменение размера: " + node.name);
      if (dimension === "fill" && (!node.parent || !node.parent.layoutMode || node.parent.layoutMode === "NONE")) {
        throw new Error("Fill требует родителя с Auto Layout: " + node.name);
      }
      if (dimension === "hug" && node.type !== "TEXT" && (!layoutMode || layoutMode === "NONE")) {
        throw new Error("Hug требует Auto Layout или TEXT: " + node.name);
      }
    }
    if (value.componentProperties !== undefined) {
      if (node.type !== "INSTANCE") throw new Error("componentProperties поддерживается только для INSTANCE: " + node.name);
      for (const [key, val] of Object.entries(value.componentProperties)) {
        const current = node.componentProperties[key];
        if (!current) throw new Error("Не найдено свойство компонента: " + key);
        if (typeof current.value !== typeof val) throw new Error("Неверный тип свойства компонента: " + key);
      }
    }
    const richTextRequested = node.type === "TEXT" && textFields.some((field) => value[field] !== undefined);
    if (richTextRequested) {
      const fontSegments = node.characters.length ? node.getStyledTextSegments(["fontName"]) : [];
      const currentFonts = fontSegments.length ? fontSegments.map((segment) => segment.fontName) : [node.fontName];
      for (const font of currentFonts) if (font !== figma.mixed) await loadFont(font);
    }

    const fields = new Set(Object.keys(value).map((key) => fieldMap[key]).filter(Boolean));
    if (richTextRequested) {
      for (const field of ["characters", "fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "textAlignHorizontal"]) {
        if (field in node) fields.add(field);
      }
    }
    if (value.effectStyleId !== undefined && "effects" in node) fields.add("effects");
    if (value.fillStyleId !== undefined) fields.add("fills");
    if (value.strokeStyleId !== undefined) fields.add("strokes");
    if (value.cornerRadius !== undefined) for (const field of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) if (field in node) fields.add(field);
    if (value.padding !== undefined) for (const field of layoutFields.slice(2, 6)) fields.add(field);
    if (value.layout !== undefined) for (const field of layoutFields) if (field in node) fields.add(field);
    const dimensions = scaleChanged || ["vectorPaths", "booleanOperation", "pointCount"].some(field => value[field] !== undefined) || value.width !== undefined || value.height !== undefined || value.layout !== undefined || value.padding !== undefined || value.gap !== undefined || richTextRequested;
    if (dimensions) {
      for (const field of ["layoutSizingHorizontal", "layoutSizingVertical", "textAutoResize"]) if (field in node) fields.add(field);
    }
    const values = Object.fromEntries([...fields].map((field) => [field, copy(node[field])]));
    const sizes = dimensions ? { width: node.width, height: node.height } : null;
    const bindings = copy(node.boundVariables || {});
    const componentProperties = value.componentProperties ? Object.fromEntries(Object.keys(value.componentProperties).map((key) => [key, node.componentProperties[key].value])) : null;
    const segments = node.type === "TEXT" && node.characters.length && richTextRequested
      ? node.getStyledTextSegments(["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent", "listOptions", "listSpacing", "indentation", "hyperlink", "textStyleId", "fillStyleId", "boundVariables"])
      : [];
    const styles = {};
    if (fields.has("fills") && "fillStyleId" in node && node.fillStyleId !== figma.mixed) styles.fillStyleId = node.fillStyleId;
    if (fields.has("strokes") && "strokeStyleId" in node && node.strokeStyleId !== figma.mixed) styles.strokeStyleId = node.strokeStyleId;
    if (richTextRequested && "textStyleId" in node && node.textStyleId !== figma.mixed) styles.textStyleId = node.textStyleId;
    if ((value.effects !== undefined || value.effectStyleId !== undefined) && "effectStyleId" in node && node.effectStyleId !== figma.mixed) styles.effectStyleId = node.effectStyleId;

    return {
      applyScale() {
        if (originalScale === null) return;
        if (node.scaleFactor !== originalScale) throw new Error("Масштаб изменился во время проверки: " + node.id);
        if (scaleChanged) {
          node.rescale(value.scaleFactor / originalScale);
          if (node.scaleFactor !== value.scaleFactor) throw new Error("scaleFactor не подтверждён обратным чтением: " + node.id);
        }
      },
      async restore() {
        const errors = [];
        const attempt = async (label, fn) => { try { await fn(); } catch (error) { errors.push(label + ": " + error.message); } };
        if (node.removed) throw new Error("Узел удалён: " + node.id);
        if (originalScale !== null && node.scaleFactor !== originalScale) await attempt("scaleFactor", () => {
          const ratio = originalScale / node.scaleFactor;
          if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 100) throw new Error("Текущий масштаб не допускает обратимого rescale");
          node.rescale(ratio);
          if (node.scaleFactor !== originalScale) throw new Error("Исходный масштаб не восстановлен");
        });
        if (componentProperties && Object.entries(componentProperties).some(([key, value]) => !sameValue(node.componentProperties[key]?.value, value))) await attempt("componentProperties", () => node.setProperties(componentProperties));
        if (styles.textStyleId !== undefined && !sameValue(node.textStyleId, styles.textStyleId)) await attempt("textStyleId", () => typeof node.setTextStyleIdAsync === "function" ? node.setTextStyleIdAsync(styles.textStyleId) : (node.textStyleId = styles.textStyleId));
        if (styles.effectStyleId !== undefined && !sameValue(node.effectStyleId, styles.effectStyleId)) await attempt("effectStyleId", () => typeof node.setEffectStyleIdAsync === "function" ? node.setEffectStyleIdAsync(styles.effectStyleId) : (node.effectStyleId = styles.effectStyleId));
        // Font and layout must precede characters and sizing.
        for (const field of new Set(["fontName", "layoutMode", ...fields])) {
          if (!(field in values) || values[field] === figma.mixed) continue;
          if (sameValue(node[field], values[field])) continue;
          await attempt(field, () => { node[field] = copy(values[field]); });
        }
        for (const segment of segments) {
          if (segment.textStyleId) await attempt("textStyle", () => node.setRangeTextStyleIdAsync(segment.start, segment.end, segment.textStyleId));
          if (segment.fillStyleId) await attempt("fillStyle", () => node.setRangeFillStyleIdAsync(segment.start, segment.end, segment.fillStyleId));
          for (const field of ["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "listOptions", "listSpacing", "indentation", "hyperlink"]) {
            if (segment[field] === undefined) continue;
            const setter = "setRange" + field[0].toUpperCase() + field.slice(1);
            await attempt(setter, () => node[setter](segment.start, segment.end, copy(segment[field])));
          }
          // Clear newly introduced scalar aliases before restoring original ranges.
          if (typeof node.setRangeBoundVariable === "function") for (const field of ["fontFamily", "fontWeight", "fontSize", "lineHeight"]) {
            if (value[field] === undefined && value.textRuns === undefined) continue;
            await attempt("clearRangeBinding:" + field, () => node.setRangeBoundVariable(segment.start, segment.end, field, null));
          }
          for (const [field, binding] of Object.entries(segment.boundVariables || {})) {
            if (!binding || Array.isArray(binding) || binding.type !== "VARIABLE_ALIAS") continue;
            await attempt("rangeBinding:" + field, async () => {
              const variable = await figma.variables.getVariableByIdAsync(binding.id);
              if (!variable) throw new Error("Переменная недоступна: " + binding.id);
              node.setRangeBoundVariable(segment.start, segment.end, field, variable);
            });
          }
        }
        await attempt("paragraphRanges", () => applyParagraphRanges(figma, node, segments));
        if (sizes) {
          if (node.width !== sizes.width || node.height !== sizes.height) await attempt("resize", () => node.type === "SECTION" ? node.resizeWithoutConstraints(sizes.width, sizes.height) : node.resize(sizes.width, sizes.height));
          for (const field of ["textAutoResize", "layoutSizingHorizontal", "layoutSizingVertical"]) {
            if (field in values && node[field] !== values[field]) await attempt(field, () => { node[field] = values[field]; });
          }
        }
        for (const [field, id] of Object.entries(styles)) {
          if (field === "textStyleId" || field === "effectStyleId" || sameValue(node[field], id)) continue;
          const setter = field === "fillStyleId" ? "setFillStyleIdAsync" : "setStrokeStyleIdAsync";
          await attempt(field, () => node[setter](id));
        }
        // Paint bindings are part of the restored paints. Restore scalar bindings separately.
        const bindingFields = new Set([...fields, ...Object.keys(value), ...(sizes ? ["width", "height"] : [])]);
        for (const field of bindingFields) {
          const binding = bindings[field];
          if (!binding || Array.isArray(binding) || binding.type !== "VARIABLE_ALIAS") continue;
          await attempt("binding:" + field, async () => {
            const variable = await figma.variables.getVariableByIdAsync(binding.id);
            if (!variable) throw new Error("Переменная недоступна: " + binding.id);
            node.setBoundVariable(field, variable);
          });
        }
        if (errors.length) throw new Error(errors.join("; "));
      },
    };
  }

  async function rollback(snapshots, created, cause) {
    const errors = [];
    for (const node of [...created].reverse()) {
      try { if (!node.removed) node.remove(); } catch (error) { errors.push(error.message); }
    }
    for (const snapshot of [...snapshots].reverse()) {
      try { await snapshot.restore(); } catch (error) { errors.push(error.message); }
    }
    const error = new Error(cause.message + (errors.length ? ". Откат неполный: " + errors.join("; ") : ". Изменения пакета отменены."));
    error.operationStatus = errors.length ? "partial" : "rolled_back";
    error.rollbackErrors = errors;
    throw error;
  }

  return { prepare, loadFont, rollback };
}
