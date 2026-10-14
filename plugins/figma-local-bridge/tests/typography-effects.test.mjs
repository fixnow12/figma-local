import test from "node:test";
import assert from "node:assert/strict";
import { buildRenderCode, buildPatchCode, buildInspectCode } from "../src/figma-code.mjs";
import { normalizeScreenSpec, parseRenderScreenInput, patchNodesSchema } from "../src/schemas.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = (code, figma) => new AsyncFunction("figma", code)(figma);
const regular = { family: "Factor IO", style: "Regular" };
const medium = { family: "Factor IO", style: "Medium" };
const fields = ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration", "textStyleId", "fills", "listOptions", "listSpacing", "indentation"];

// Execute the actual compiled Plugin API program, including font-load guards,
// per-character styles, parenting and cleanup. No snapshot/string-only tests.
function fixture() {
  let serial = 0;
  const nodes = new Map(), loaded = new Set();
  const fonts = [regular, medium, { family: "Inter", style: "Regular" }, { family: "Inter", style: "Semi Bold" }];
  const mixed = Symbol("mixed");
  const styles = new Map([
    ["text-style", { type: "TEXT", fontName: medium, fontSize: 23, lineHeight: { unit: "PERCENT", value: 130 } }],
    ["effect-style", { type: "EFFECT", effects: [{ type: "DROP_SHADOW", radius: 8, offset: { x: 0, y: 3 }, color: { r: 0, g: 0, b: 0, a: 0.2 }, blendMode: "NORMAL", visible: true }] }],
  ]);
  function create(type) {
    const node = { type, id: String(++serial), name: type, x: 0, y: 0, width: 100, height: 100, visible: true, opacity: 1,
      effects: [], effectStyleId: "", fills: [], strokes: [], strokeWeight: 0, cornerRadius: 0,
      resize(w, h) { this.width = w; this.height = h; },
      setPluginData(key, value) { this.data ||= {}; this.data[key] = value; },
      getPluginData(key) { return this.data?.[key] || ""; },
      remove() { for (const child of [...(this.children || [])]) child.remove(); this.parent?.children.splice(this.parent.children.indexOf(this), 1); nodes.delete(this.id); this.removed = true; },
      async setEffectStyleIdAsync(id) { if (id && styles.get(id)?.type !== "EFFECT") throw new Error("Missing effect style"); this.effectStyleId = id; this.effects = structuredClone(styles.get(id)?.effects || []); },
    };
    if (type === "SECTION") node.resizeWithoutConstraints = function(w,h) { this.width=w; this.height=h; };
    if (["PAGE", "SECTION", "FRAME"].includes(type)) Object.assign(node, {
      children: [], layoutMode: "NONE", layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED",
      appendChild(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); this.children.push(child); child.parent = this; },
      findAll() { return this.children.flatMap(child => [child, ...(child.findAll?.() || [])]); },
      findOne(fn) { return this.findAll().find(fn); },
    });
    if (type === "TEXT") {
      let content = "", chars = [];
      const defaults = { fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", textStyleId: "", fills: [], listOptions: {type:"NONE"}, listSpacing:0, indentation:0 };
      const ensureLoaded = () => { for (const props of chars.length ? chars : [defaults]) assert.ok(loaded.has(JSON.stringify(props.fontName)), "font must be loaded before text mutation"); };
      for (const field of fields) {
        Object.defineProperty(node, field, { configurable: true, get() { const values = chars.length ? chars.map(c => c[field]) : [defaults[field]]; return values.every(v => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : mixed; }, set(value) { ensureLoaded(); defaults[field] = value; chars.forEach(c => { c[field] = value; }); if (!["textStyleId", "fills"].includes(field)) { defaults.textStyleId = ""; chars.forEach(c => { c.textStyleId = ""; }); } } });
        node["setRange" + field[0].toUpperCase() + field.slice(1)] = (start, end, value) => { ensureLoaded(); chars.slice(start, end).forEach(c => { c[field] = value; }); };
        node["getRange" + field[0].toUpperCase() + field.slice(1)] = (start, end) => { const values = chars.slice(start, end).map(c => c[field]); return values.every(v => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : mixed; };
      }
      Object.defineProperty(node, "characters", { get: () => content, set(value) { ensureLoaded(); content = value; chars = Array.from({ length: value.length }, (_, i) => structuredClone(chars[i] || defaults)); } });
      node.getStyledTextSegments = requested => {
        const result = [];
        for (let i = 0; i < chars.length; i++) {
          const values = Object.fromEntries(requested.map(f => [f, chars[i][f]]));
          const last = result.at(-1);
          if (last && requested.every(f => JSON.stringify(last[f]) === JSON.stringify(values[f]))) { last.end++; last.characters += content[i]; }
          else result.push({ start: i, end: i + 1, characters: content[i], ...structuredClone(values) });
        }
        return result;
      };
      node.textAlignHorizontal = "LEFT";
      node.textAutoResize = "WIDTH_AND_HEIGHT";
      node.hasMissingFont = false;
      node.setTextStyleIdAsync = async id => { const style = styles.get(id); if (id && style?.type !== "TEXT") throw new Error("Missing style"); if (style) for (const f of ["fontName", "fontSize", "lineHeight"]) node[f] = structuredClone(style[f]); node.textStyleId = id; };
      node.setRangeTextStyleIdAsync = async (start, end, id) => { const style = styles.get(id); node.setRangeTextStyleId(start, end, id); if (style) for (const f of ["fontName", "fontSize", "lineHeight"]) node["setRange" + f[0].toUpperCase() + f.slice(1)](start, end, structuredClone(style[f])); };
    }
    nodes.set(node.id, node);
    return node;
  }
  const figma = { mixed, currentPage: create("PAGE"), viewport: { scrollAndZoomIntoView() {} },
    createSection: () => create("SECTION"), createFrame: () => create("FRAME"), createText: () => create("TEXT"), createRectangle: () => create("RECTANGLE"),
    async loadFontAsync(font) { if (!fonts.some(f => JSON.stringify(f) === JSON.stringify(font))) throw new Error("Font unavailable"); loaded.add(JSON.stringify(font)); },
    async listAvailableFontsAsync() { return fonts.map(fontName => ({ fontName })); },
    async getStyleByIdAsync(id) { return styles.get(id); },
    async getNodeByIdAsync(id) { return nodes.get(id); },
  };
  // Figma creates nodes on the current page before appendChild moves them.
  for (const key of ["createSection", "createFrame", "createText", "createRectangle"]) {
    const original = figma[key]; figma[key] = () => { const node = original(); figma.currentPage.appendChild(node); return node; };
  }
  return { figma, nodes, loaded };
}

function renderInput(text = {}, root = {}) {
  return { spec: { key: "screen", name: "Экран", type: "screen", width: 320, height: 240, ...root,
    nodes: [{ key: "title", name: "Заголовок", type: "text", content: "Аа Бб", fontFamily: "Factor IO", fontStyle: "Medium", fontSize: 32, ...text }],
  }, replace: true };
}
async function render(figma, input = renderInput()) {
  const parsed = parseRenderScreenInput(input);
  return execute(buildRenderCode({ ...parsed, spec: normalizeScreenSpec(parsed.spec) }), figma);
}
async function patch(figma, patches) { return execute(buildPatchCode(patchNodesSchema.parse({ patches })), figma); }
async function inspect(figma, nodeId) { return (await execute(buildInspectCode({ nodeId, depth: 4, maxNodes: 50 }), figma)).selection[0]; }

test('render dryRun проверяет шрифты без создания и изменения существующего результата', async () => {
  const { figma, nodes } = fixture();
  const initial = await render(figma);
  const count = nodes.size;
  const selection = [...figma.currentPage.selection];
  const result = await render(figma, { ...renderInput(), dryRun: true });
  assert.equal(result.ready, true);
  assert.equal(nodes.size, count);
  assert.ok(nodes.has(initial.rootId));
  assert.deepEqual(figma.currentPage.selection, selection);
  await assert.rejects(render(figma, { ...renderInput({ fontStyle: 'Unavailable' }), dryRun: true }), /Недоступен шрифт/);
  assert.equal(nodes.size, count);
});

test('dryRun обнаруживает координаты в Auto Layout до создания обложки', async () => {
  const { figma, nodes } = fixture();
  const count = nodes.size;
  await assert.rejects(render(figma, { ...renderInput({ x: 64, y: 418 }), dryRun: true }), /x\/y.*раскладк/);
  assert.equal(nodes.size, count);
  const input = { ...renderInput({ x: 64, y: 418 }, { layout: { direction: 'none' } }), dryRun: true };
  assert.equal((await render(figma, input)).ready, true);
});

test('dryRun отклоняет недопустимые диапазоны и отсутствующий стиль эффектов до записи', async () => {
  for (const input of [renderInput({ content: 'Hi', textRuns: [{ start: 0, end: 999, fontSize: 15 }] }),
    renderInput({}, { effectStyleId: 'missing' })]) {
    const { figma, nodes } = fixture();
    const count = nodes.size;
    await assert.rejects(render(figma, { ...input, dryRun: true }), /textRuns|стиль эффектов/);
    assert.equal(nodes.size, count);
  }
});

test('dryRun проверяет также исходный шрифт пустого нового TEXT', async () => {
  const { figma, nodes } = fixture();
  const originalLoad = figma.loadFontAsync;
  figma.loadFontAsync = async font => {
    if (font.family === 'Inter') throw new Error('Default font unavailable');
    return originalLoad(font);
  };
  const count = nodes.size;
  await assert.rejects(render(figma, { ...renderInput(), dryRun: true }), /Inter/);
  assert.equal(nodes.size, count);
});

test("render принимает числовые строки и сохраняет межстрочный интервал в Figma", async () => {
  const { figma } = fixture();
  const { rootId } = await render(figma, renderInput({ lineHeight: "28", fontSize: "20", letterSpacing: "-0.5" }));
  const title = (await inspect(figma, rootId)).children[0];
  assert.deepEqual(title.lineHeight, { unit: "PIXELS", value: 28 });
  assert.equal(title.fontSize, 20);
  assert.deepEqual(title.letterSpacing, { unit: "PIXELS", value: -0.5 });
});

test("числовые строки соблюдают пределы; токены, AUTO, Fill/Hug и textRuns сохраняются", () => {
  const parsed = parseRenderScreenInput(renderInput({ width: "fill", height: "hug", lineHeight: "AUTO",
    textRuns: [{ start: 0, end: 2, lineHeight: "28" }],
  }, { cornerRadius: "12", layout: { gap: "-2", padding: { top: "8" } } }));
  assert.equal(parsed.spec.cornerRadius, 12);
  assert.equal(parsed.spec.layout.gap, -2);
  assert.equal(parsed.spec.layout.padding.top, 8);
  assert.equal(parsed.spec.nodes[0].textRuns[0].lineHeight, 28);
  assert.equal(parsed.spec.nodes[0].lineHeight, "AUTO");
  assert.equal(parsed.spec.nodes[0].width, "fill");
  assert.equal(parsed.spec.nodes[0].height, "hug");
  for (const lineHeight of ["0", "-1", "28px", "", " ", "NaN", "Infinity", "1e999", "$colors.blue"]) {
    assert.throws(() => parseRenderScreenInput(renderInput({ lineHeight })), undefined, lineHeight);
  }
  assert.throws(() => parseRenderScreenInput(renderInput({ opacity: "1.1" })));
  assert.throws(() => parseRenderScreenInput(renderInput({ width: "0" })));
  assert.throws(() => parseRenderScreenInput(renderInput({}, { layout: { padding: "-1" } })));
});

test("render → inspect сохраняет точную типографику и многослойные тени", async () => {
  const { figma } = fixture();
  const effects = [
    { type: "DROP_SHADOW", radius: 12, spread: -2, offset: { x: 1, y: 4 }, color: { r: 0.12, g: 0.18, b: 0.26, a: 0.16 }, blendMode: "MULTIPLY", visible: false, showShadowBehindNode: true, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:1:2" } } },
    { type: "INNER_SHADOW", radius: 3, offset: { x: 0, y: -1 }, color: "#00000033" },
  ];
  const { rootId } = await render(figma, renderInput({ lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PERCENT", value: -1 }, textDecoration: "UNDERLINE" }, { effects }));
  const root = await inspect(figma, rootId), title = root.children[0];
  assert.equal(title.fontFamily, "Factor IO"); assert.equal(title.fontStyle, "Medium"); assert.equal(title.fontSize, 32);
  assert.deepEqual(title.lineHeight, { unit: "PERCENT", value: 120 });
  assert.deepEqual(title.letterSpacing, { unit: "PERCENT", value: -1 });
  assert.equal(title.textDecoration, "UNDERLINE");
  assert.deepEqual(root.effects[0], effects[0]);
  assert.equal(root.effects[1].color.a, 0.2);
});

test("недоступное начертание не заменяется на Regular; неудачная замена сохраняет исходный экран", async () => {
  const { figma, nodes } = fixture();
  const initial = await render(figma);
  const count = nodes.size;
  await assert.rejects(render(figma, renderInput({ fontStyle: "Bold" })), /Недоступен шрифт.*Bold/);
  assert.equal(nodes.size, count);
  assert.ok(nodes.has(initial.rootId));
});

test("алиас SemiBold разрешается только в то же начертание Semi Bold", async () => {
  const { figma } = fixture();
  const { rootId } = await render(figma, renderInput({ fontFamily: "Inter", fontStyle: "SemiBold" }));
  assert.equal((await inspect(figma, rootId)).children[0].fontStyle, "Semi Bold");
});

test("сбой загрузки существующего шрифта требует согласования замены и сохраняет экран", async () => {
  const { figma, nodes } = fixture();
  const initial = await render(figma);
  const count = nodes.size;
  const requested = [];
  figma.loadFontAsync = async font => { requested.push(font); throw new Error("Font service unavailable"); };
  await assert.rejects(render(figma), error => {
    assert.match(error.message, /есть в списке/);
    assert.match(error.message, /Font service unavailable/);
    assert.match(error.message, /без явного согласия пользователя/);
    return true;
  });
  assert.deepEqual(requested, [medium]);
  assert.equal(nodes.size, count);
  assert.ok(nodes.has(initial.rootId));
});

test("ошибка списка или загрузки алиаса сохраняет причину и указание согласовать замену", async () => {
  for (const mode of ["listing", "alias", "no-listing", "missing"]) {
    const { figma } = fixture();
    if (mode !== "missing") figma.loadFontAsync = async () => { throw new Error("Load failed"); };
    if (mode === "listing") figma.listAvailableFontsAsync = async () => { throw new Error("List failed"); };
    if (mode === "no-listing") delete figma.listAvailableFontsAsync;
    await assert.rejects(render(figma, renderInput({ fontFamily: mode === "missing" ? "YS Text" : "Inter", fontStyle: "SemiBold" })), error => {
      assert.match(error.message, /без явного согласия пользователя/);
      assert.match(error.message, mode === "alias" ? /эквивалентное начертание/ : mode === "missing" ? /нет совпадающего/ : /отсутствие шрифта не подтверждено/);
      return true;
    });
  }
});

test("patch меняет типографику существующего слоя и не сбрасывает её при изменении content", async () => {
  const { figma } = fixture();
  const { rootId } = await render(figma);
  await patch(figma, [{ key: "title", set: { fontStyle: "Regular", fontSize: 18, lineHeight: "AUTO", letterSpacing: 0, textCase: "UPPER" } }]);
  await patch(figma, [{ key: "title", set: { content: "Новый текст" } }]);
  const title = (await inspect(figma, rootId)).children[0];
  assert.equal(title.fontStyle, "Regular"); assert.equal(title.fontSize, 18);
  assert.deepEqual(title.lineHeight, { unit: "AUTO" }); assert.equal(title.textCase, "UPPER");
});

test("смешанные начертания читаются и воссоздаются через textRuns", async () => {
  const { figma } = fixture();
  const { rootId } = await render(figma, renderInput({ textRuns: [{ start: 0, end: 2, fontStyle: "Regular", fontSize: 16 }, { start: 3, end: 5, fontStyle: "Medium", fontSize: 24 }] }));
  const title = (await inspect(figma, rootId)).children[0];
  assert.ok(title.mixedTextProperties.includes("fontName"));
  assert.equal(title.textRuns[0].fontStyle, "Regular");
  await assert.rejects(patch(figma, [{ key: "title", set: { content: "Другой текст" } }]), /смешанное оформление/);
  await render(figma, renderInput({ textRuns: title.textRuns }));
  const again = await inspect(figma, figma.currentPage.selection[0].id);
  assert.deepEqual(again.children[0].textRuns, title.textRuns);
});

test("ссылки на текстовый стиль и стиль эффектов применяются при создании и правке", async () => {
  const { figma } = fixture();
  const input = renderInput({ textStyleId: "text-style" }, { effectStyleId: "effect-style" });
  for (const key of ["fontFamily", "fontStyle", "fontSize"]) delete input.spec.nodes[0][key];
  const { rootId } = await render(figma, input);
  let root = await inspect(figma, rootId);
  assert.equal(root.children[0].textStyleId, "text-style"); assert.equal(root.children[0].fontSize, 23);
  assert.equal(root.effectStyleId, "effect-style"); assert.equal(root.effects.length, 1);
  await patch(figma, [{ key: "screen", set: { effects: [] } }, { key: "title", set: { textStyleId: "text-style" } }]);
  root = await inspect(figma, rootId); assert.deepEqual(root.effects, []);
  await patch(figma, [{ key: "title", set: { textStyleId: "text-style", fontFamily: "Factor IO", fontStyle: "Medium", fontSize: 23, lineHeight: { unit: "PERCENT", value: 130 } } }]);
  assert.equal((await inspect(figma, rootId)).children[0].textStyleId, "text-style", "Повтор точных значений стиля не должен разрывать связь");
});

test("append использует тот же путь шрифтов и теней; ошибка не оставляет слои", async () => {
  const { figma, nodes } = fixture(); await render(figma);
  const count = nodes.size;
  await assert.rejects(patch(figma, [{ key: "screen", append: [{ key: "bad", name: "Ошибка", type: "text", content: "Нет", fontFamily: "Factor IO", fontWeight: "Black" }] }]), /Недоступен шрифт/);
  assert.equal(nodes.size, count);
  await patch(figma, [{ key: "screen", append: [{ key: "extra", name: "Текст", type: "text", content: "Да", fontFamily: "Factor IO", fontWeight: "Medium", effects: [{ type: "DROP_SHADOW", color: "#00000020", offset: { x: 0, y: 1 }, radius: 2 }] }] }]);
  const extra = (await inspect(figma, figma.currentPage.selection[0].id)).children[1];
  assert.equal(extra.fontStyle, "Medium"); assert.equal(extra.effects.length, 1);
});

test("неправильные тени и диапазоны отклоняются, отсутствие effects сохраняет существующие", async () => {
  assert.throws(() => parseRenderScreenInput(renderInput({}, { effects: [{ type: "DROP_SHADOW", radius: 3 }] })), /color/);
  assert.throws(() => patchNodesSchema.parse({ patches: [{ key: "title", set: { effects: [{ type: "INNER_SHADOW", radius: -1 }] } }] }));
  const { figma } = fixture(); const { rootId } = await render(figma, renderInput({}, { effectStyleId: "effect-style" }));
  await patch(figma, [{ key: "screen", set: { name: "Переименован" } }]);
  assert.equal((await inspect(figma, rootId)).effects.length, 1);
  await assert.rejects(patch(figma, [{ key: "title", set: { content: "Коротко", textRuns: [{ start: 0, end: 99, fontStyle: "Regular" }] } }]), /Диапазоны/);
  assert.equal((await inspect(figma, rootId)).children[0].content, "Аа Бб");
});

test("новые вложенные контейнеры не обрезают тени, явный clipContent сохраняется", async () => {
  const { figma } = fixture(); const input = renderInput();
  input.spec.nodes.push({ key: "wrapper", name: "Контейнер", type: "frame" }, { key: "clipped", name: "Обрезание", type: "frame", clipContent: true });
  const { rootId } = await render(figma, input);
  let root = await inspect(figma, rootId);
  assert.equal(root.children[1].clipContent, false);
  assert.equal(root.children[2].clipContent, true);
  await patch(figma, [{ key: "clipped", set: { clipContent: false } }]);
  root = await inspect(figma, rootId); assert.equal(root.children[2].clipContent, false);
});

test("токены размера в смешанных диапазонах разрешаются до исполнения", () => {
  const input = renderInput({ textRuns: [{ start: 0, end: 2, fontSize: "$numbers.small", lineHeight: "$numbers.leading" }] });
  input.spec.tokens = { numbers: [{ name: "small", value: 13 }, { name: "leading", value: 18 }] };
  const parsed = parseRenderScreenInput(input);
  const normalized = normalizeScreenSpec(parsed.spec);
  assert.equal(normalized.children[0].textRuns[0].fontSize, 13);
  assert.equal(normalized.children[0].textRuns[0].lineHeight, 18);
});

test("смешанные цвета textRuns сохраняются при render, чтении и patch", async () => {
  const { figma } = fixture();
  const primary = [{ type: "SOLID", color: { r: 0.0078, g: 0.0078, b: 0.1333 }, opacity: 0.7 }];
  const link = [{ type: "SOLID", color: { r: 0.4392, g: 0.1843, b: 0.9569 }, opacity: 1 }];
  const { rootId } = await render(figma, renderInput({ fills: primary, textRuns: [{ start: 3, end: 5, fills: link }] }));
  const title = (await inspect(figma, rootId)).children[0];
  assert.deepEqual(title.textRuns[0].fills, primary);
  assert.deepEqual(title.textRuns[1].fills, link);
  await patch(figma, [{ key: "title", set: { textRuns: [{ start: 0, end: 2, fills: link }] } }]);
  const next = (await inspect(figma, rootId)).children[0];
  assert.deepEqual(next.textRuns[0].fills, link);
});

 test("v2 renders and patches list ranges with complete readback", async()=>{
 const {figma}=fixture();const {rootId}=await render(figma,renderInput({listOptions:{type:"ORDERED"},listSpacing:8,indentation:1,textRuns:[{start:0,end:2,listOptions:{type:"UNORDERED"},indentation:2}]}));
 let title=(await inspect(figma,rootId)).children[0];assert.equal(title.textRuns[0].listOptions.type,"UNORDERED");assert.equal(title.textRuns[0].indentation,2);
 await patch(figma,[{id:title.id,set:{listOptions:{type:"NONE"},indentation:0}}]);title=(await inspect(figma,rootId)).children[0];assert.deepEqual(title.listOptions,{type:"NONE"});assert.equal(title.indentation,0);
 });

test('captured fills retain opacity after native GLASS side effects in render, append and patch', async () => {
  const {figma,nodes}=fixture(),create=figma.createFrame;
  const fills=[{type:'SOLID',visible:true,opacity:1,blendMode:'NORMAL',color:{r:0.9412000179290771,g:0.9412000179290771,b:0.980400025844574}}];
  const glass={type:'GLASS',visible:true,radius:20,refraction:0.24,depth:2,lightAngle:-45,lightIntensity:0.8,dispersion:0,splay:0};
  figma.createFrame=()=>{
    const node=create();let effects=[];
    Object.defineProperty(node,'effects',{get:()=>effects,set:value=>{effects=structuredClone(value);if(value.some(effect=>effect.type==='GLASS'))node.fills=node.fills.map(p=>({...p,opacity:0.2}));}});
    return node;
  };
  const frame={key:'glass-child',name:'Glass',type:'frame',width:100,height:40,fills,effects:[glass]};
  const result=await render(figma,{spec:{key:'glass-root',name:'Glass screen',type:'screen',width:320,height:240,fills,effects:[glass],nodes:[frame]}});
  const root=nodes.get(result.rootId),child=root.children[0];
  assert.deepEqual(root.fills,fills);assert.deepEqual(child.fills,fills);
  await patch(figma,[{id:child.id,set:{fills,effects:[{...glass,depth:4}]}},{id:root.id,append:[{...frame,key:'glass-append'}]}]);
  assert.deepEqual(child.fills,fills);assert.deepEqual(root.children[1].fills,fills);
  assert.equal(child.effects[0].depth,4);
});
