import { z } from 'zod';
import { compileOperation } from './scene-access.mjs';

const id = z.string().min(1).max(160);
const cursor = z.string().regex(/^\d+:[0-9a-f]{1,8}$/).optional();
const fileKey = z.string().min(1);

export const catalogInventoryInputSchema = { fileKey, nodeId: id.optional() };
export const catalogInventorySchema = z.object(catalogInventoryInputSchema).strict();
export const catalogPageInputSchema = {
  fileKey, pageId: id, nodeId: id.optional(), mode: z.enum(['roles', 'manifest', 'resources']),
  cursor, limit: z.number().int().min(1).max(200).optional(),
  componentIds: z.array(id).min(1).max(8).optional(),
  manifestFingerprint: z.string().regex(/^[0-9a-f]{1,8}$/).optional(),
};
export const catalogPageSchema = z.object(catalogPageInputSchema).strict().superRefine((value, ctx) => {
  if (value.mode === 'resources') {
    if (!value.componentIds || !value.manifestFingerprint || value.cursor || value.limit) ctx.addIssue({code:'custom',message:'resources требует componentIds и manifestFingerprint без cursor/limit'});
    if (value.componentIds && new Set(value.componentIds).size !== value.componentIds.length) ctx.addIssue({code:'custom',message:'Повторяющиеся componentIds'});
  } else if (value.componentIds || value.manifestFingerprint) ctx.addIssue({code:'custom',message:'componentIds и manifestFingerprint допустимы только для resources'});
});
export const catalogExampleInputSchema = {
  fileKey, pageId: id, nodeId: id, cursor, limit: z.number().int().min(1).max(200).optional(),
  includePng: z.boolean().optional(), screenshotScale: z.number().min(0.5).max(4).optional(),
};
export const catalogExampleSchema = z.object(catalogExampleInputSchema).strict();

// These functions are serialized into the Desktop plugin. Keep each operation
// self-contained: MCP accepts typed data only and never exposes a JS argument.
async function inventory(figma, input, access) {
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Неверный целевой файл');
  const pages = figma.root.children.filter(node => node.type === 'PAGE').map(node => ({id:node.id,name:node.name}));
  let sourceScope;
  if (input.nodeId) {
    const node = await access.node(input.nodeId);
    let page = node;
    while (page && page.type !== 'PAGE') page = page.parent;
    if (!page || !pages.some(item => item.id === page.id)) throw new Error('Узел не принадлежит целевому файлу');
    await access.read(page.loadAsync(), 'страница ' + page.id);
    sourceScope = {nodeId:node.id,nodeType:node.type,nodeName:node.name,pageId:page.id,pageName:page.name};
  }
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Целевой файл изменился во время чтения');
  return {schemaVersion:1,kind:'inventory',fileKey:input.fileKey,pages,complete:true,...(sourceScope?{sourceScope}:{})};
}

async function pageScan(figma, input, access) {
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Неверный целевой файл');
  const page = await access.node(input.pageId);
  if (page.type !== 'PAGE' || !figma.root.children.includes(page)) throw new Error('pageId должен указывать на страницу целевого файла');
  await access.read(page.loadAsync(), 'страница ' + page.id);
  const root = input.nodeId ? await access.node(input.nodeId) : page;
  for (let ancestor = root; ancestor && ancestor !== page; ancestor = ancestor.parent) {
    if (!ancestor.parent) throw new Error('nodeId находится вне pageId');
  }
  let ancestor = root;
  while (ancestor && ancestor !== page) ancestor = ancestor.parent;
  if (ancestor !== page) throw new Error('nodeId находится вне pageId');
  const deprecated = node => /deprecated/i.test(String(node.name ?? '') + ' ' + String(node.description ?? ''));
  const active = node => {
    for (let current=node; current && current !== page; current=current.parent) if (deprecated(current)) return false;
    return true;
  };
  const descendants = [], stack=[root];
  while (stack.length) {
    access.check();
    if (descendants.length && descendants.length % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const node=stack.pop();descendants.push(node);
    if ('children' in node) for (let index=node.children.length-1;index>=0;index--) stack.push(node.children[index]);
  }
  const ids = descendants.filter(node => ['COMPONENT','COMPONENT_SET'].includes(node.type) && active(node)).map(node => node.id).sort();
  const hash = value => {
    let result=2166136261;
    for (const char of JSON.stringify(value)) result=Math.imul(result^char.charCodeAt(0),16777619)>>>0;
    return result.toString(16);
  };
  const manifestFingerprint = hash(ids);
  if (input.mode === 'manifest') {
    const fingerprint = manifestFingerprint;
    let offset=0;
    if (input.cursor) {
      const [position, expected]=input.cursor.split(':');
      if (expected !== fingerprint) throw new Error('Курсор устарел: manifest изменился');
      offset=Number(position);
    }
    if (offset > ids.length) throw new Error('Курсор вне manifest');
    const limit=input.limit ?? 100, next=offset+limit;
    const unreadNodeCount=Math.max(0,ids.length-next);
    if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Целевой файл изменился во время чтения');
    return {schemaVersion:1,kind:'manifest',fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,
      componentIds:ids.slice(offset,next),manifestFingerprint,complete:next>=ids.length,
      cursor:input.cursor??null,nextCursor:next<ids.length?`${next}:${fingerprint}`:null,
      offset,total:ids.length,fingerprint,coverage:{returned:Math.min(limit,ids.length-offset),total:ids.length},
      unreadNodeIds:ids.slice(next,next+limit),unreadNodeCount,unreadNodeIdsComplete:unreadNodeCount<=limit};
  }
  if (input.mode === 'roles') {
    const signal = node => {
      const pending=[node];
      while(pending.length){const current=pending.pop();
        if(current!==root&&['COMPONENT','COMPONENT_SET'].includes(current.type))continue;
        if(current.type==='TEXT'||current.type==='INSTANCE')return true;
        if('children'in current)pending.push(...current.children);
      }
      return false;
    };
    const componentBlocks = node => {
      let count=0;const pending=[node];
      while(pending.length){const current=pending.pop();
        if(!active(current))continue;
        if(['COMPONENT','COMPONENT_SET'].includes(current.type)){if(++count>=2)return 2;continue;}
        if('children'in current&&current.type!=='INSTANCE')pending.push(...current.children);
      }
      return count;
    };
    const candidates=descendants.filter(node => node.type==='COMPONENT_SET' && active(node)).map(node => ({
      id:node.id,name:node.name,type:node.type,
      variantIds:node.children.filter(child => child.type==='COMPONENT' && active(child)).map(child => child.id).sort(),
    }));
    const pending=[root];
    while(pending.length){const node=pending.pop();
      if(!active(node)||node.type==='COMPONENT_SET')continue;
      if(node.type==='COMPONENT'||node.type==='INSTANCE'){
        if(node===root&&root!==page)candidates.push({id:node.id,name:node.name,type:node.type});
        continue;
      }
      if(['FRAME','GROUP','SECTION'].includes(node.type)&&(signal(node)||componentBlocks(node)>=2)){
        candidates.push({id:node.id,name:node.name,type:node.type});continue;
      }
      if('children'in node)for(let index=node.children.length-1;index>=0;index--)pending.push(node.children[index]);
    }
    candidates.sort((a,b)=>a.id.localeCompare(b.id));
    // A single cursor slices the tagged union. The complete role fingerprint
    // matches catalog-source-roles.mjs for assembled componentIds/candidates.
    const fingerprint=hash({componentIds:ids,exampleCandidates:candidates});
    const tagged=[...ids.map(id=>({kind:'component',id})),...candidates.map(value=>({kind:'example',value}))];
    let offset=0;
    if (input.cursor) {
      const [position,expected]=input.cursor.split(':');
      if(expected!==fingerprint)throw new Error('Курсор устарел: роли изменились');
      offset=Number(position);
    }
    if(offset>tagged.length)throw new Error('Курсор вне списка ролей');
    const limit=input.limit??100,next=offset+limit,items=tagged.slice(offset,next);
    const unreadNodeCount=Math.max(0,tagged.length-next);
    if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Целевой файл изменился во время чтения');
    return {schemaVersion:1,kind:'source-roles',fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,
      componentIds:items.filter(item=>item.kind==='component').map(item=>item.id),
      exampleCandidates:items.filter(item=>item.kind==='example').map(item=>item.value),
      complete:next>=tagged.length,cursor:input.cursor??null,nextCursor:next<tagged.length?`${next}:${fingerprint}`:null,
      offset,total:tagged.length,counts:{componentIds:ids.length,exampleCandidates:candidates.length},fingerprint,
      coverage:{returned:items.length,total:tagged.length},
      unreadNodeIds:tagged.slice(next,next+limit).map(item=>item.kind==='component'?item.id:item.value.id),
      unreadNodeCount,unreadNodeIdsComplete:unreadNodeCount<=limit};
  }
  // Each resource request proves its exact selected IDs still belong to the
  // current full manifest before returning any published-key evidence.
  if (input.manifestFingerprint!==manifestFingerprint) throw new Error('Manifest изменился; обновите список компонентов');
  const selected=input.componentIds;
  if (selected.some(id=>!ids.includes(id))) throw new Error('componentIds не принадлежат manifest выбранной области');
  const components=[],variables=[],styles=[],gaps=[];
  const relevant=new Map();
  for (const id of selected) {
    const node=descendants.find(node=>node.id===id);
    if(!node)throw new Error('Компонент недоступен: '+id);
    let publishStatus;
    try {publishStatus=await access.read(node.getPublishStatusAsync(),'статус компонента '+id);} catch(_error) {gaps.push({kind:'component',id,reason:'publish-status-unavailable'});continue;}
    if(!['CURRENT','CHANGED','UNPUBLISHED'].includes(publishStatus)) {gaps.push({kind:'component',id,reason:'publish-status-unavailable'});continue;}
    for (const child of [node,...('findAll' in node?node.findAll(()=>true):[])]) relevant.set(child.id,child);
    components.push({id,name:node.name,key:node.key,kind:node.type==='COMPONENT'?'component':'component_set',publishStatus,
      width:node.width,height:node.height,...(node.type==='COMPONENT'?{variantProperties:node.variantProperties??null}:{variantGroupProperties:node.variantGroupProperties??null})});
  }
  const variableIds=new Set(),styleIds=new Set();
  const visitBinding=value=>{
    if(!value||typeof value!=='object')return;
    if(value.type==='VARIABLE_ALIAS'&&typeof value.id==='string'){variableIds.add(value.id);return;}
    for(const nested of Object.values(value)) Array.isArray(nested)?nested.forEach(visitBinding):visitBinding(nested);
  };
  for(const node of relevant.values()) {
    if('boundVariables' in node)visitBinding(node.boundVariables);
    for(const field of ['fillStyleId','strokeStyleId','textStyleId','effectStyleId','gridStyleId'])
      if(field in node&&typeof node[field]==='string'&&node[field])styleIds.add(node[field]);
  }
  if(variableIds.size+styleIds.size>1000)throw new Error('Слишком много связанных ресурсов (>1000); укажите меньший batch componentIds');
  for(const id of [...variableIds].sort()) {
    let variable;
    try {variable=await access.read(figma.variables.getVariableByIdAsync(id),'переменная '+id);} catch(_error) {gaps.push({kind:'variable',id,reason:'source-variable-unavailable'});continue;}
    if(!variable||variable.remote){gaps.push({kind:'variable',id,reason:'source-variable-unavailable'});continue;}
    let collection;
    try {collection=await access.read(figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId),'коллекция '+variable.variableCollectionId);} catch(_error) {gaps.push({kind:'variable',id,reason:'collection-unavailable'});continue;}
    if(!collection){gaps.push({kind:'variable',id,reason:'collection-unavailable'});continue;}
    if(/deprecated/i.test(String(variable.name)+' '+String(collection.name)))continue;
    let publishStatus;
    try {publishStatus=await access.read(variable.getPublishStatusAsync(),'статус переменной '+id);} catch(_error) {gaps.push({kind:'variable',id,reason:'publish-status-unavailable'});continue;}
    if(!['CURRENT','CHANGED','UNPUBLISHED'].includes(publishStatus)){gaps.push({kind:'variable',id,reason:'publish-status-unavailable'});continue;}
    variables.push({id,name:variable.name,key:variable.key,resolvedType:variable.resolvedType,collectionKey:collection.key,collectionName:collection.name,publishStatus});
  }
  for(const id of [...styleIds].sort()) {
    let style;
    try {style=await access.read(figma.getStyleByIdAsync(id),'стиль '+id);} catch(_error) {gaps.push({kind:'style',id,reason:'source-style-unavailable'});continue;}
    if(!style||style.remote){gaps.push({kind:'style',id,reason:'source-style-unavailable'});continue;}
    if(/deprecated/i.test(String(style.name)+' '+String(style.description)))continue;
    let publishStatus;
    try {publishStatus=await access.read(style.getPublishStatusAsync(),'статус стиля '+id);} catch(_error) {gaps.push({kind:'style',id,reason:'publish-status-unavailable'});continue;}
    if(!['CURRENT','CHANGED','UNPUBLISHED'].includes(publishStatus)){gaps.push({kind:'style',id,reason:'publish-status-unavailable'});continue;}
    styles.push({id,name:style.name,key:style.key,styleType:style.type,publishStatus});
  }
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Целевой файл изменился во время чтения');
  return {schemaVersion:1,kind:'resource-batch',fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,
    manifestFingerprint,componentIds:selected,complete:true,scanComplete:true,
    coverage:{componentIds:selected,representedComponentIds:[...components.map(value=>value.id),...gaps.filter(value=>value.kind==='component').map(value=>value.id)].sort()},
    counts:{components:components.length,variables:variables.length,styles:styles.length,gaps:gaps.length},components,variables,styles,gaps};
}

async function example(figma,input,access) {
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Неверный целевой файл');
  const page=await access.node(input.pageId);
  if(page.type!=='PAGE'||!figma.root.children.includes(page))throw new Error('pageId должен указывать на страницу целевого файла');
  await access.read(page.loadAsync(),'страница '+page.id);
  const root=await access.node(input.nodeId);
  let ancestor=root;
  while(ancestor&&ancestor!==page)ancestor=ancestor.parent;
  if(ancestor!==page)throw new Error('nodeId находится вне pageId');
  const all=[],stack=[root];
  while(stack.length){access.check();
    if(all.length && all.length % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const node=stack.pop();all.push(node);
    if('children'in node)for(let index=node.children.length-1;index>=0;index--)stack.push(node.children[index]);
  }
  const hash=value=>{let result=2166136261;for(const char of JSON.stringify(value))result=Math.imul(result^char.charCodeAt(0),16777619)>>>0;return result.toString(16);};
  const fingerprint=hash(all.map(node=>[node.id,node.type,node.name,node.parent?.id??null,'children'in node?node.children.map(child=>child.id):[],node.type==='TEXT'?node.characters:null]));
  let offset=0;
  if(input.cursor){const [position,expected]=input.cursor.split(':');if(expected!==fingerprint)throw new Error('Курсор устарел: дерево изменилось');offset=Number(position);}
  if(offset>all.length)throw new Error('Курсор вне дерева');
  const limit=input.limit??100,next=offset+limit,gaps=[];
  const safe=(node,field)=>{
    try {const value=node[field];return value===figma.mixed?'MIXED':value;} catch(error){gaps.push({nodeId:node.id,field,reason:'property-unavailable',message:String(error.message||error)});return undefined;}
  };
  const fields=['visible','x','y','width','height','absoluteBoundingBox','relativeTransform','rotation','constraints','opacity','fills','strokes','strokeWeight','strokeAlign','strokeTopWeight','strokeBottomWeight','strokeLeftWeight','strokeRightWeight','dashPattern','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','cornerSmoothing','clipsContent','effects','blendMode','isMask','maskType','fillStyleId','strokeStyleId','effectStyleId','gridStyleId','boundVariables','explicitVariableModes','layoutMode','layoutWrap','layoutSizingHorizontal','layoutSizingVertical','layoutPositioning','itemSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','primaryAxisAlignItems','counterAxisAlignItems','counterAxisSpacing','strokesIncludedInLayout','itemReverseZIndex','minWidth','maxWidth','minHeight','maxHeight','reactions','componentPropertyReferences','vectorPaths','booleanOperation','pointCount','strokeCap','strokeJoin','componentProperties','overrides','variantProperties','variantGroupProperties','componentPropertyDefinitions','remote','key','description'];
  const textFields=['characters','fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','listOptions','listSpacing','indentation','textStyleId','textAlignHorizontal','textAlignVertical','textAutoResize','hasMissingFont'];
  const nodes=[];
  for(const node of all.slice(offset,next)){
    const value={id:node.id,parentId:node.parent?.id??null,childIds:'children'in node?node.children.map(child=>child.id):[],
      childIndex:node.parent?.children?.findIndex(child=>child.id===node.id)??-1,type:node.type,name:node.name,
      properties:{}};
    for(const field of fields)if(field in node){
      if(field==='componentPropertyDefinitions'&&node.type==='COMPONENT'&&node.parent?.type==='COMPONENT_SET')continue;
      const item=safe(node,field);if(item!==undefined)value.properties[field]=item;
    }
    if(node.type==='TEXT'){
      for(const field of textFields)if(field in node){const item=safe(node,field);if(item!==undefined)value.properties[field]=item;}
      for(const [label,segmentFields] of [['textSegments',['fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','fills','textStyleId','fillStyleId','boundVariables']],['hyperlinks',['hyperlink']]]){
        try {value.properties[label]=node.getStyledTextSegments(segmentFields);} catch(error){gaps.push({nodeId:node.id,field:label,reason:'property-unavailable',message:String(error.message||error)});}
      }
    }
    if(node.type==='INSTANCE'){
      try {const component=await access.read(node.getMainComponentAsync(),'исходный компонент '+node.id);
        value.mainComponent=component?{status:'resolved',id:component.id,key:component.key,name:component.name,remote:component.remote}:{status:'missing'};
      } catch(error){value.mainComponent={status:'unavailable',message:String(error.message||error)};gaps.push({nodeId:node.id,field:'mainComponent',reason:'resource-unavailable'});}
    }
    nodes.push(value);
  }
  if(JSON.stringify(nodes).length*3>4000000)throw new Error('Фрагмент примера слишком велик (>4 МБ); уменьшите limit или выберите меньшую ветку');
  if (typeof figma.fileKey === 'string' && figma.fileKey !== input.fileKey) throw new Error('Целевой файл изменился во время чтения');
  const unreadNodeCount=Math.max(0,all.length-next);
  return {schemaVersion:1,kind:'example',fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,
    nodes,gaps,complete:next>=all.length,cursor:input.cursor??null,nextCursor:next<all.length?`${next}:${fingerprint}`:null,
    offset,total:all.length,fingerprint,coverage:{returned:nodes.length,total:all.length,firstNodeId:nodes[0]?.id??null,lastNodeId:nodes.at(-1)?.id??null},
    unreadNodeIds:all.slice(next,next+limit).map(node=>node.id),unreadNodeCount,unreadNodeIdsComplete:unreadNodeCount<=limit,
    screenshotNodeId:input.includePng?root.id:null};
}

export const buildCatalogInventoryCode=input=>compileOperation(inventory,input,{readOnly:true});
export const buildCatalogPageCode=input=>compileOperation(pageScan,input,{readOnly:true});
export const buildCatalogExampleCode=input=>compileOperation(example,input,{readOnly:true});
