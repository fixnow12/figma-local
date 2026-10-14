import { DATA_KEY } from "../../src/figma-code.mjs";

// Behavioral test double: tracks nodes/parents, writes, resource failures and removals.
// It intentionally does not claim to emulate Figma's layout engine.
export function createFigmaMock() {
  const nodes = new Map();
  const writes = [];
  const loadedFonts = [];
  const variables = new Map();
  const collections = [];
  const styles = [];
  const libraryCollections = [];
  const libraryVariables = new Map();
  let thumbnail = null;
  const copyValue = (value) => value === undefined || typeof value === "symbol" ? value : JSON.parse(JSON.stringify(value));
  let counter = 0;
  let rejectWrite = () => false;
  const mixed = Symbol("mixed");
  let page;
  function make(type, props = {}, parent = page) {
    const data = {};
    const raw = {
      id: "node:" + ++counter, name: type, type, parent: null, removed: false,
      x: 0, y: 0, width: 100, height: 40, visible: true, opacity: 1,
      fills: [], strokes: [], strokeWeight: 1, boundVariables: {}, isMask: false, maskType: "ALPHA", rotation: 0,
      layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      getPluginData: (key) => data[key] || "",
      getPluginDataKeys: () => Object.keys(data),
      setPluginData: (key, value) => { data[key] = value; },
      resize(width, height) { this.width = width; this.height = height; },
      remove() {
        for (const child of [...(this.children || [])]) child.remove();
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
        this.removed = true;
        nodes.delete(this.id);
      },
      async setFillStyleIdAsync(id) { this.fillStyleId = id; },
      async setStrokeStyleIdAsync(id) { this.strokeStyleId = id; },
      setBoundVariable(field, variable) {
        const bindings = { ...this.boundVariables };
        if (variable) bindings[field] = { type: "VARIABLE_ALIAS", id: variable.id };
        else delete bindings[field];
        this.boundVariables = bindings;
        if (variable?.resolveForConsumer) this[field] = copyValue(variable.resolveForConsumer(this).value);
      },
      clone() {
        function duplicate(source, parent) {
          const values = Object.fromEntries(Object.entries(source)
            .filter(([key, value]) => typeof value !== "function" && !["id", "parent", "children", "selection", "removed"].includes(key))
            .map(([key, value]) => [key, copyValue(value)]));
          const result = make(source.type, values, parent);
          for (const key of source.getPluginDataKeys()) result.setPluginData(key, source.getPluginData(key));
          for (const child of source.children || []) duplicate(child, result);
          return result;
        }
        return duplicate(this, this.parent);
      },
    };
    if (type === "SECTION") raw.resizeWithoutConstraints = function(width,height) { this.width=width; this.height=height; };
    if (["PAGE", "SECTION", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(type)) {
      Object.assign(raw, {
        children: [], selection: [], layoutMode: type === "PAGE" ? "NONE" : "VERTICAL",
        itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
        primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutWrap: "NO_WRAP",
        clipsContent: false, cornerRadius: 0,
        appendChild(child) {
          if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
          this.children = [...this.children, child];
          child.parent = this;
        },
        insertChild(index, child) {
          const available = this.children.filter((node) => node !== child);
          if (!Number.isInteger(index) || index < 0 || index > available.length) throw new Error("Индекс за границами");
          for (let ancestor = this; ancestor; ancestor = ancestor.parent) if (ancestor === child) throw new Error("Цикл");
          if (child.parent && child.parent !== this) child.parent.children = child.parent.children.filter((node) => node !== child);
          available.splice(index, 0, child);
          this.children = available;
          child.parent = this;
        },
        async loadAsync() {},
        findAllWithCriteria({ types }) { return this.findAll((node) => types.includes(node.type)); },
        findAll(predicate = () => true) {
          return this.children.flatMap((node) => [...(predicate(node) ? [node] : []), ...(node.findAll?.(predicate) || [])]);
        },
      });
    }
    if (type === "TEXT") {
      Object.assign(raw, {
        characters: "Текст", fontName: { family: "Inter", style: "Regular" }, fontSize: 14,
        textAutoResize: "WIDTH_AND_HEIGHT", textAlignHorizontal: "LEFT", lineHeight: { unit: "AUTO" },
        letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", hyperlink: null,
        fillStyleId: "", textStyleId: "",
        getStyledTextSegments(fields) {
          return [{ start: 0, end: this.characters.length, ...Object.fromEntries(fields.map((field) => [field, this[field]])) }];
        },
      });
      for (const field of ["fontName", "fontSize", "fills", "textCase", "textDecoration", "letterSpacing", "lineHeight", "hyperlink"]) {
        raw["getRange" + field[0].toUpperCase() + field.slice(1)] = function() { return this[field]; };
        raw["setRange" + field[0].toUpperCase() + field.slice(1)] = function(_start, _end, value) { this[field] = value; };
      }
      raw.setRangeTextStyleIdAsync = async function(_start, _end, id) { this.textStyleId = id; };
      raw.setRangeFillStyleIdAsync = async function(_start, _end, id) { this.fillStyleId = id; };
      raw.setRangeBoundVariable = function(_start, _end, field, variable) { this.setBoundVariable(field, variable); };
    }
    const node = new Proxy(Object.assign(raw, props), {
      set(target, field, value) {
        if (rejectWrite(target, field, value)) throw new Error("Injected write failure: " + field);
        target[field] = value;
        writes.push({ id: target.id, field, value });
        return true;
      },
    });
    nodes.set(node.id, node);
    if (parent) parent.appendChild(node);
    return node;
  }
  page = make("PAGE", { name: "Страница" }, null);
  const figma = {
    currentPage: page, mixed, root: { name: "Тестовый файл", children: [page] },
    async getFileThumbnailNodeAsync() { return thumbnail; },
    async setFileThumbnailNodeAsync(node) { thumbnail = node; },
    async setCurrentPageAsync(nextPage) {
      if (nextPage.type !== "PAGE") throw new Error("Ожидается PAGE");
      this.currentPage = nextPage;
    },
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
    loadFontAsync: async (font) => {
      if (font.family === "Missing") throw new Error("Шрифт недоступен");
      loadedFonts.push(font);
    },
    createFrame: () => make("FRAME"), createSection: () => make("SECTION"),
    createText: () => make("TEXT"), createRectangle: () => make("RECTANGLE", { cornerRadius: 0 }),
    createEllipse: () => make("ELLIPSE"), createComponent: () => make("COMPONENT"),
    base64Decode: (data) => Buffer.from(data, "base64"),
    createImage: () => { throw new Error("Некорректное изображение"); },
    createNodeFromSvg: () => { throw new Error("Некорректный SVG"); },
    viewport: { scrollAndZoomIntoView() {} },
    getLocalPaintStylesAsync: async () => styles.filter((style) => style.type === "PAINT"),
    getLocalTextStylesAsync: async () => styles.filter((style) => style.type === "TEXT"),
    getLocalEffectStylesAsync: async () => styles.filter((style) => style.type === "EFFECT"),
    getLocalGridStylesAsync: async () => styles.filter((style) => style.type === "GRID"),
    variables: {
      getVariableByIdAsync: async (id) => variables.get(id) || null,
      getLocalVariablesAsync: async () => [...variables.values()],
      getLocalVariableCollectionsAsync: async () => collections,
      setBoundVariableForPaint(paint, field, variable) {
        const boundVariables = { ...(paint.boundVariables || {}) };
        if (variable) boundVariables[field] = { type: "VARIABLE_ALIAS", id: variable.id };
        else delete boundVariables[field];
        return { ...copyValue(paint), boundVariables };
      },
    },
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => libraryCollections,
      getVariablesInLibraryCollectionAsync: async (key) => libraryVariables.get(key) || [],
    },
  };
  function addVariable({ id, name = id, type = "FLOAT", value = 14, valuesByMode = { default: value }, collectionId = "collection" }) {
    const variable = {
      id, key: "key:" + id, name, resolvedType: type, variableCollectionId: collectionId, valuesByMode,
      resolveForConsumer(node) {
        const mode = node.explicitVariableModes?.[collectionId] || Object.keys(valuesByMode)[0];
        return { value: valuesByMode[mode], resolvedType: type };
      },
    };
    variables.set(id, variable);
    return variable;
  }
  return {
    figma, page, make, nodes, writes, loadedFonts, addVariable, variables, collections, styles, libraryCollections, libraryVariables,
    key(node, value) { node.setPluginData(DATA_KEY, value); return node; },
    rejectWrites(fn) { rejectWrite = fn; },
  };
}

export async function executeGenerated(figma, code) {
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  return new AsyncFunction("figma", code)(figma);
}
