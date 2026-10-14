// Serialized by compileOperation. Only whole top-level containers, within one file.
export async function transferPageNodes(figma, input, access) {
  let source, target, originalSource, originalTarget;
  const prepared = [], fonts = new Set();
  const checkedFields = ['x','y','width','height','relativeTransform','rotation','name','visible','opacity','locked','fills','strokes','effects','fillStyleId','strokeStyleId','effectStyleId','boundVariables','explicitVariableModes','characters','fontName','fontSize','textStyleId','textAutoResize','hyperlink','reactions','layoutMode','primaryAxisSizingMode','counterAxisSizingMode','layoutSizingHorizontal','layoutSizingVertical','layoutPositioning','layoutAlign','layoutGrow','clipsContent','constraints','componentProperties'];
  function properties(node, excludePosition = false) {
    const value = {};
    for (const field of checkedFields) if (field in node && !(excludePosition && ['x','y','relativeTransform'].includes(field))) value[field]=access.copy(node[field]);
    if(node.type==='TEXT' && typeof node.getStyledTextSegments==='function') value.textSegments=access.copy(node.getStyledTextSegments(['fontName','fontSize','textStyleId','fills','hyperlink']));
    return JSON.stringify(value);
  }
  function intact(entry, moved = false) {
    const current=tree(entry.node);
    return current.length===entry.nodes.length && current.every((n,i)=>n===entry.nodes[i]) && entry.evidence.every(e=>
      e.node.parent===(moved && e.node===entry.node ? target : e.parent) && signature(e.node)===e.mode &&
      properties(e.node,moved && e.node===entry.node && !!entry.item.position)===(moved && e.node===entry.node && entry.item.position ? e.withoutPosition : e.properties));
  }

  const signature = node => JSON.stringify(Object.entries(node.resolvedVariableModes || {}).sort(([a],[b])=>a.localeCompare(b)));
  function tree(root) {
    const result=[],stack=[root];
    while(stack.length) { access.check(); const n=stack.pop();result.push(n);if(result.length>5000)throw new Error('pageTransfer превышает 5000 узлов');
      if('children' in n) { if(n.children.length+stack.length+result.length>5000)throw new Error('pageTransfer превышает 5000 узлов');for(let i=n.children.length-1;i>=0;i--)stack.push(n.children[i]); }
    }
    return result;
  }
  function checkPage(page) {
    if (!page || page.removed || page.type !== 'PAGE' || !figma.root.children.includes(page)) throw new Error('Page не принадлежит текущему файлу');
  }
  function sameChildren(page, saved) {
    if (page.children.length !== saved.length || saved.some((n,i)=>page.children[i]!==n)) throw new Error('Структура Page изменилась во время проверки');
  }
  function validateNode(node) {
    if (node.removed || node.parent !== source || !['FRAME','SECTION'].includes(node.type)) throw new Error('Для pageTransfer нужен верхнеуровневый FRAME/SECTION исходной Page');
    if (tree(node).some(n=>['COMPONENT','COMPONENT_SET'].includes(n.type))) throw new Error('Контейнер содержит определения компонентов');
    access.placement(node,target);
  }
  try {
    if (!input.fileKey || (figma.fileKey && input.fileKey !== figma.fileKey)) throw new Error('Нужен точный fileKey');
    if (figma.skipInvisibleInstanceChildren === true) throw new Error('Полное чтение скрытых потомков INSTANCE недоступно');
    const route = input.pageTransfer;
    if (!route || route.sourcePageId === route.targetPageId || new Set(input.moves.map(x=>x.id)).size !== input.moves.length) throw new Error('Нужны разные Pages и уникальные узлы');
    source = await access.node(route.sourcePageId); target = await access.node(route.targetPageId);
    checkPage(source); checkPage(target);
    await access.read(source.loadAsync(),'исходная Page'); await access.read(target.loadAsync(),'целевая Page');
    originalSource = [...source.children]; originalTarget = [...target.children];
    const next = [...originalTarget]; let total = 0;
    for (const item of input.moves) {
      if (item.parentId !== target.id) throw new Error('parentId должен совпадать с targetPageId');
      const node = await access.node(item.id); validateNode(node);
      const nodes = tree(node); total += nodes.length;
      if (total > 5000) throw new Error('pageTransfer превышает 5000 узлов; сократите пакет');
      const index = item.index ?? next.length;
      if (!Number.isInteger(index) || index < 0 || index > next.length) throw new Error('Индекс вставки выходит за границы');
      next.splice(index,0,node);
      const evidence = nodes.map(n=>({node:n,parent:n.parent,mode:signature(n),properties:properties(n),withoutPosition:properties(n,true)}));
      const geometry = {x:node.x,y:node.y,width:node.width,height:node.height,transform:access.copy(node.relativeTransform)};
      prepared.push({item,node,index,nodes,evidence,geometry});
      for (const child of nodes) if (child.type === 'TEXT') {
        const names = child.fontName === figma.mixed ? child.getRangeAllFontNames(0,child.characters.length) : [child.fontName];
        for (const font of names) { const key=JSON.stringify(font); if (!fonts.has(key)) { await access.loadFont(font); fonts.add(key); } }
      }
    }
    access.stablePage(); checkPage(source);checkPage(target);sameChildren(source,originalSource);sameChildren(target,originalTarget);
    for (const entry of prepared) {
      validateNode(entry.node);
      if (!intact(entry)) throw new Error('Дерево или режимы изменились во время проверки');
      const g=entry.geometry,n=entry.node;
      if(n.x!==g.x||n.y!==g.y||n.width!==g.width||n.height!==g.height||JSON.stringify(n.relativeTransform)!==JSON.stringify(g.transform)) throw new Error('Геометрия изменилась во время проверки');
    }
  } catch(error) { error.operationStatus='not_applied';throw error; }
  const rollback=[()=>{
    sameChildren(source,originalSource);sameChildren(target,originalTarget);
    if(prepared.some(entry=>!intact(entry)))throw new Error('Откат не восстановил проверяемые свойства потомков');
  }];
  try {
    for(const {item,node,index,geometry:g,evidence} of prepared) {
      access.stablePage();const oldIndex=source.children.indexOf(node);
      rollback.push(()=>{
        if(node.removed||source.removed)throw new Error('Исходный узел или Page удалены');
        source.insertChild(oldIndex,node);
        if(g.transform)node.relativeTransform=access.copy(g.transform);else{node.x=g.x;node.y=g.y;}
        if(node.width!==g.width||node.height!==g.height){if(node.type==='SECTION')node.resizeWithoutConstraints(g.width,g.height);else node.resize(g.width,g.height);}
        if(evidence.some(e=>signature(e.node)!==e.mode))throw new Error('Режимы не восстановлены');
      });
      target.insertChild(index,node);
      if(g.transform)node.relativeTransform=access.copy(g.transform);else{node.x=g.x;node.y=g.y;}
      if(item.position){node.x=item.position.x;node.y=item.position.y;}
      if(node.width!==g.width||node.height!==g.height)throw new Error('Размер изменился при переносе');
      if(evidence.some(e=>signature(e.node)!==e.mode))throw new Error('Режимы переменных изменились при переносе');
      const entry=prepared.find(e=>e.node===node);
      if(!intact(entry,true))throw new Error('Перенос изменил проверяемые свойства потомков');
    }
    access.stablePage();
    if(prepared.some(entry=>!intact(entry,true)))throw new Error('Пакет изменил ранее перенесённые свойства');
    return {checkedFields,sourcePageId:source.id,targetPageId:target.id,moved:prepared.map(({node})=>({id:node.id,parentId:node.parent.id,index:target.children.indexOf(node)})),screenshotNodeId:prepared[0]?.node.id};
  } catch(error) { return access.failWithRollback(error,rollback); }
}
