import { transferPageNodes } from "./page-transfer.mjs";
import { compileOperation } from "./scene-access.mjs";

async function cloneNodes(figma, input, access) {
  const prepared = [];
  const reservedKeys = new Set();
  const parentSizes = new Map();
  const originalChildren = new Map();
  try {
    for (const node of access.page.findAll()) {
      const key = node.getPluginData(access.dataKey);
      if (key) reservedKeys.add(key);
    }
    let count = 0;
    for (const item of input.copies) {
      const source = await access.node(item.sourceId);
      access.structural(source);
      if (typeof source.clone !== "function" || ["PAGE", "DOCUMENT"].includes(source.type)) throw new Error("Узел нельзя клонировать: " + source.id);
      const parent = item.parentId ? await access.node(item.parentId) : source.parent;
      access.parent(parent);
      access.placement(source, parent, item.position);
      const descendants = source.findAll?.() || [];
      if ([source, ...descendants].some((node) => ["COMPONENT", "COMPONENT_SET"].includes(node.type))) throw new Error("Копия содержит определения компонентов. Используйте экземпляры компонентов.");
      count += descendants.length + 1;
      if (count > (input.maxNodes ?? 500)) throw new Error("Копия превышает maxNodes; сократите выделение или явно увеличьте лимит");
      if (reservedKeys.has(item.key)) throw new Error("Ключ уже существует: " + item.key);
      reservedKeys.add(item.key);
      const size = parentSizes.get(parent) ?? parent.children.length;
      if (!originalChildren.has(parent)) originalChildren.set(parent, [...parent.children]);
      const index = item.index ?? size;
      if (index > size) throw new Error("Индекс вставки выходит за границы: " + index);
      parentSizes.set(parent, size + 1);
      prepared.push({ item, source, parent, index, sources: [source, ...descendants] });
    }
    for (const { parent } of prepared) {
      if (prepared.some(({ source }) => access.ancestors(parent).includes(source))) throw new Error("Нельзя вставлять копии внутрь копируемых источников в одном пакете");
    }
    access.stablePage();
    for (const [parent, children] of originalChildren) {
      if (parent.removed || parent.children.length !== children.length || children.some((node, index) => parent.children[index] !== node)) throw new Error("Структура родителя изменилась во время проверки");
      access.parent(parent);
    }
    for (const { source, sources } of prepared) {
      access.structural(source);
      const current = [source, ...(source.findAll?.() || [])];
      if (current.length !== sources.length || current.some((node, index) => node !== sources[index])) throw new Error("Структура источника изменилась во время проверки");
    }
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }
  const rollback = [];
  const copies = [];
  try {
    for (const { item, source, parent, index, sources } of prepared) {
      access.check();
      const clone = source.clone();
      rollback.push(() => { if (!clone.removed) clone.remove(); });
      const clonedNodes = [clone, ...(clone.findAll?.() || [])];
      if (clonedNodes.length !== sources.length) throw new Error("Структура копии отличается от источника");
      const nodes = [];
      for (const [i, node] of clonedNodes.entries()) {
        const key = i === 0 ? item.key : "clone:" + clone.id + ":" + node.id;
        if (i > 0 && (key.length > 160 || reservedKeys.has(key))) throw new Error("Не удалось назначить уникальный ключ копии");
        reservedKeys.add(key);
        node.setPluginData(access.dataKey, key);
        nodes.push({ id: node.id, sourceId: sources[i].id, key });
      }
      if (item.name !== undefined) clone.name = item.name;
      parent.insertChild(index, clone);
      if (item.position) { clone.x = item.position.x; clone.y = item.position.y; }
      copies.push({ id: clone.id, key: item.key, sourceId: source.id, parentId: parent.id, nodes });
    }
    access.check();
    return { copies, nodeCount: copies.reduce((sum, item) => sum + item.nodes.length, 0), screenshotNodeId: copies[0]?.id };
  } catch (error) {
    return await access.failWithRollback(error, rollback);
  }
}

async function moveNodes(figma, input, access) {
  const prepared = [];
  const loadedFonts = new Set();
  const simulatedChildren = new Map();
  const originalChildren = new Map();
  function children(parent) {
    if (!simulatedChildren.has(parent)) {
      originalChildren.set(parent, [...parent.children]);
      simulatedChildren.set(parent, [...parent.children]);
    }
    return simulatedChildren.get(parent);
  }
  try {
    for (const item of input.moves) {
      const node = await access.node(item.id);
      access.structural(node);
      if (node.type === "TEXT") {
        const fonts = node.fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
        for (const font of fonts) {
          const key = JSON.stringify(font);
          if (!loadedFonts.has(key)) { await access.loadFont(font); loadedFonts.add(key); }
          access.check();
        }
      }
      // Groups can disappear when their final child is moved; restrict this operation to persistent containers.
      access.parent(node.parent);
      const parent = item.parentId ? await access.node(item.parentId) : node.parent;
      access.parent(parent);
      if (access.ancestors(parent).includes(node)) throw new Error("Нельзя переместить узел в самого себя или потомка");
      access.placement(node, parent, item.position);
      const oldChildren = children(node.parent);
      const previousIndex = oldChildren.indexOf(node);
      oldChildren.splice(previousIndex, 1);
      const nextChildren = children(parent);
      const index = item.index ?? (parent === node.parent && item.position ? Math.min(previousIndex, nextChildren.length) : nextChildren.length);
      if (index > nextChildren.length) throw new Error("Индекс вставки выходит за границы: " + index);
      nextChildren.splice(index, 0, node);
      prepared.push({ item, node, parent, index });
    }
    for (const { node, parent } of prepared) {
      if (prepared.some((other) => other.node !== node && (access.ancestors(parent).includes(other.node) || access.ancestors(node.parent).includes(other.node)))) {
        throw new Error("Перемещайте родителей и их потомков отдельными пакетами");
      }
    }
    access.stablePage();
    for (const [parent, children] of originalChildren) {
      if (parent.removed || parent.children.length !== children.length || children.some((node, index) => parent.children[index] !== node)) throw new Error("Структура родителя изменилась во время проверки");
      access.parent(parent);
    }
    for (const { node, parent, item } of prepared) {
      access.structural(node);
      access.placement(node, parent, item.position);
    }
  } catch (error) {
    error.operationStatus = "not_applied";
    throw error;
  }
  const rollback = [];
  const moved = [];
  try {
    for (const { item, node, parent, index } of prepared) {
      access.check();
      const previousParent = node.parent;
      const previousIndex = previousParent.children.indexOf(node);
      const values = {};
      for (const field of ["relativeTransform", "x", "y", "width", "height", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "layoutAlign", "layoutGrow"]) {
        if (field in node) values[field] = access.copy(node[field]);
      }
      rollback.push(() => {
        if (node.removed || previousParent.removed) throw new Error("Исходный узел или родитель удалён: " + node.id);
        previousParent.insertChild(previousIndex, node);
        if (values.relativeTransform) node.relativeTransform = access.copy(values.relativeTransform);
        else { node.x = values.x; node.y = values.y; }
        if (typeof node.resize === "function") node.resize(values.width, values.height);
        for (const field of ["layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow"]) {
          if (field in values) node[field] = values[field];
        }
      });
      parent.insertChild(index, node);
      if (item.position) { node.x = item.position.x; node.y = item.position.y; }
      moved.push({ id: node.id, parentId: parent.id });
    }
    access.check();
    return { moved: moved.map((item) => ({ ...item, index: prepared.find((entry) => entry.node.id === item.id).parent.children.findIndex((node) => node.id === item.id) })), screenshotNodeId: moved[0]?.id };
  } catch (error) {
    return await access.failWithRollback(error, rollback);
  }
}

export const buildCloneCode = (input) => compileOperation(cloneNodes, input);
export const buildMoveCode = (input) => compileOperation(input.pageTransfer ? transferPageNodes : moveNodes, input);
