import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
import {catalogInventorySchema,catalogPageSchema,catalogExampleSchema,buildCatalogInventoryCode,buildCatalogPageCode,buildCatalogExampleCode} from '../src/catalog-read.mjs';

const run=(mock,build,input)=>executeGenerated(mock.figma,build(input));
function fixture(){
  const mock=createFigmaMock();
  mock.figma.fileKey='target';
  const page=mock.make('PAGE',{name:'Каталог'},null);mock.figma.root.children.push(page);
  const set=mock.make('COMPONENT_SET',{name:'Chip',key:'set-key',variantGroupProperties:{State:{values:['Default','Hover']}},getPublishStatusAsync:async()=> 'CURRENT'},page);
  const first=mock.make('COMPONENT',{name:'State=Default',key:'first-key',variantProperties:{State:'Default'},getPublishStatusAsync:async()=> 'CURRENT'},set);
  const second=mock.make('COMPONENT',{name:'State=Hover',key:'second-key',variantProperties:{State:'Hover'},getPublishStatusAsync:async()=> 'CHANGED'},set);
  const label=mock.make('TEXT',{characters:'Точный текст',fontSize:16,fillStyleId:'style:1',boundVariables:{fontSize:{type:'VARIABLE_ALIAS',id:'var:1'}}},first);
  const group=mock.make('FRAME',{name:'Варианты и пример'},page);
  const instance=mock.make('INSTANCE',{name:'Экземпляр',componentProperties:{Label:{type:'TEXT',value:'Текст'}},overrides:['characters'],getMainComponentAsync:async()=>first},group);
  const deprecated=mock.make('FRAME',{name:'DEPRECATED'},page);
  mock.make('COMPONENT',{name:'Old',key:'old',getPublishStatusAsync:async()=> 'CURRENT'},deprecated);
  const variable=mock.addVariable({id:'var:1',name:'Размер'});variable.getPublishStatusAsync=async()=> 'UNPUBLISHED';
  mock.figma.variables.getVariableCollectionByIdAsync=async()=>({id:'collection',key:'collection-key',name:'Tokens'});
  mock.styles.push({id:'style:1',key:'style-key',name:'Typography',type:'TEXT',getPublishStatusAsync:async()=>{throw Error('offline');}});
  mock.figma.getStyleByIdAsync=async id=>mock.styles.find(style=>style.id===id)||null;
  mock.writes.length=0;
  return {mock,page,set,first,second,label,group,instance};
}

test('inventory reads all pages and linked synthetic child without selection or page change',async()=>{
  const {mock,page,first,label}=fixture();
  mock.nodes.delete(label.id);label.id=`I${first.id};4:3`;mock.nodes.set(label.id,label);
  mock.writes.length=0;
  const result=await run(mock,buildCatalogInventoryCode,catalogInventorySchema.parse({fileKey:'target',nodeId:label.id}));
  assert.deepEqual(result.pages.map(item=>item.id),[mock.page.id,page.id]);
  assert.equal(result.sourceScope.nodeId,label.id);assert.equal(result.sourceScope.pageId,page.id);
  assert.equal(mock.figma.currentPage,mock.page);assert.equal(mock.writes.length,0);
});

test('roles and manifest expose every active variant with stable chunk coverage',async()=>{
  const {mock,page,set,first,second,group}=fixture();
  const chunks=[];let cursor;
  do {const item=await run(mock,buildCatalogPageCode,catalogPageSchema.parse({fileKey:'target',pageId:page.id,mode:'roles',limit:2,...(cursor?{cursor}:{})}));chunks.push(item);cursor=item.nextCursor;}while(cursor);
  assert.equal(chunks.at(-1).complete,true);assert.equal(new Set(chunks.map(item=>item.fingerprint)).size,1);
  assert.equal(chunks[0].unreadNodeCount,chunks[0].total-2);
  assert.equal(chunks[0].unreadNodeIds.length,2);
  assert.equal(chunks[0].unreadNodeIdsComplete,false);
  assert.deepEqual(chunks.at(-1).unreadNodeIds,[]);
  assert.equal(chunks.at(-1).unreadNodeCount,0);
  assert.equal(chunks.at(-1).unreadNodeIdsComplete,true);
  assert.deepEqual(chunks.flatMap(item=>item.componentIds),[first.id,second.id,set.id].sort());
  const candidates=chunks.flatMap(item=>item.exampleCandidates);
  assert.deepEqual(candidates.find(item=>item.id===set.id).variantIds,[first.id,second.id].sort());
  assert.ok(candidates.some(item=>item.id===group.id));
  assert.equal(chunks[0].total,3+candidates.length);
  const manifest=await run(mock,buildCatalogPageCode,catalogPageSchema.parse({fileKey:'target',pageId:page.id,mode:'manifest',limit:2}));
  assert.equal(manifest.complete,false);assert.equal(manifest.componentIds.length,2);
  assert.deepEqual(manifest.unreadNodeIds,[first.id,second.id,set.id].sort().slice(2));
  assert.equal(manifest.unreadNodeCount,1);assert.equal(manifest.unreadNodeIdsComplete,true);
  const tail=await run(mock,buildCatalogPageCode,catalogPageSchema.parse({fileKey:'target',pageId:page.id,mode:'manifest',cursor:manifest.nextCursor,limit:2}));
  assert.equal(tail.complete,true);assert.deepEqual([...manifest.componentIds,...tail.componentIds],[first.id,second.id,set.id].sort());
  assert.deepEqual(tail.unreadNodeIds,[]);assert.equal(tail.unreadNodeCount,0);assert.equal(tail.unreadNodeIdsComplete,true);
  assert.equal(mock.writes.length,0);
});

test('resource batch covers exact IDs and records unavailable publish status as a gap',async()=>{
  const {mock,page,set,first,second}=fixture();
  mock.make('TEXT',{characters:'Неопубликованный ресурс',fillStyleId:'style:excluded',boundVariables:{fontSize:{type:'VARIABLE_ALIAS',id:'var:excluded'}}},second);
  second.getPublishStatusAsync=async()=>{throw Error('unavailable');};mock.writes.length=0;
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  const batch=await run(mock,buildCatalogPageCode,catalogPageSchema.parse({fileKey:'target',pageId:page.id,mode:'resources',componentIds:[set.id,first.id,second.id],manifestFingerprint:manifest.manifestFingerprint}));
  assert.equal(batch.complete,true);assert.deepEqual(batch.coverage.representedComponentIds,[first.id,second.id,set.id].sort());
  assert.equal(batch.components.find(item=>item.id===set.id).kind,'component_set');
  assert.equal(batch.components.find(item=>item.id===first.id).kind,'component');
  assert.ok(batch.gaps.some(item=>item.id===second.id&&item.reason==='publish-status-unavailable'));
  assert.ok(batch.variables.some(item=>item.id==='var:1'&&item.publishStatus==='UNPUBLISHED'));
  assert.ok(batch.gaps.some(item=>item.id==='style:1'&&item.reason==='publish-status-unavailable'));
  const failedOnly=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'resources',componentIds:[second.id],manifestFingerprint:manifest.manifestFingerprint});
  assert.deepEqual(failedOnly.gaps,[{kind:'component',id:second.id,reason:'publish-status-unavailable'}]);
  await assert.rejects(run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'resources',componentIds:[set.id],manifestFingerprint:'bad'}),/Manifest изменился/);
  assert.equal(mock.writes.length,0);
});

test('variant component with non-readable property definitions stays a complete example',async()=>{
  const {mock,page,set,second}=fixture();
  Object.defineProperty(second,'componentPropertyDefinitions',{get(){throw Error('not available on variant');}});
  const item=await run(mock,buildCatalogExampleCode,{fileKey:'target',pageId:page.id,nodeId:set.id});
  assert.equal(item.complete,true);
  assert.ok(item.nodes.some(node=>node.id===second.id));
  assert.ok(!item.gaps.some(gap=>gap.nodeId===second.id&&gap.field==='componentPropertyDefinitions'));
  assert.equal(mock.writes.length,0);
});

test('selected page with over 20000 nodes remains traversable and paginated',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const nodes=[];
  for(let index=0;index<20010;index++)nodes.push(mock.make('RECTANGLE',{name:'Item '+index},null));
  const last=mock.make('COMPONENT',{name:'Last',key:'key-last',getPublishStatusAsync:async()=> 'CURRENT'},null);
  mock.page.children=[...nodes,last];
  for(const node of mock.page.children)node.parent=mock.page;
  mock.writes.length=0;
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:mock.page.id,mode:'manifest'});
  assert.deepEqual(manifest.componentIds,[last.id]);assert.equal(manifest.complete,true);
  const example=await run(mock,buildCatalogExampleCode,{fileKey:'target',pageId:mock.page.id,nodeId:mock.page.id,limit:2});
  assert.equal(example.complete,false);assert.equal(example.total,20012);assert.equal(example.nodes.length,2);
  assert.equal(example.unreadNodeIds.length,2);assert.equal(example.unreadNodeCount,20010);assert.equal(example.unreadNodeIdsComplete,false);
  assert.equal(mock.writes.length,0);
});

test('example paginates deep tree with exact synthetic IDs, layout, text and instance provenance',async()=>{
  const {mock,page,group,instance}=fixture();
  let last=group;
  for(let i=0;i<13;i++)last=mock.make('FRAME',{name:'Уровень '+i},last);
  const leaf=mock.make('TEXT',{characters:'Глубоко'},last);
  mock.nodes.delete(leaf.id);leaf.id=`I${instance.id};999:4`;mock.nodes.set(leaf.id,leaf);
  mock.writes.length=0;
  const chunks=[];let cursor;
  do{const item=await run(mock,buildCatalogExampleCode,catalogExampleSchema.parse({fileKey:'target',pageId:page.id,nodeId:group.id,limit:3,...(cursor?{cursor}:{})}));chunks.push(item);cursor=item.nextCursor;}while(cursor);
  const nodes=chunks.flatMap(item=>item.nodes),ids=new Set(nodes.map(item=>item.id));
  assert.equal(chunks.at(-1).complete,true);assert.equal(nodes.length,chunks[0].total);
  assert.equal(chunks[0].unreadNodeIds.length,3);assert.equal(chunks[0].unreadNodeIdsComplete,false);
  assert.deepEqual(chunks.at(-1).unreadNodeIds,[]);assert.equal(chunks.at(-1).unreadNodeCount,0);assert.equal(chunks.at(-1).unreadNodeIdsComplete,true);
  assert.ok(nodes.find(item=>item.id===leaf.id).properties.characters==='Глубоко');
  assert.equal(nodes.find(item=>item.id===instance.id).mainComponent.status,'resolved');
  assert.ok(nodes.every(item=>item.childIds.every(id=>ids.has(id))));
  assert.equal(new Set(chunks.map(item=>item.fingerprint)).size,1);assert.equal(mock.writes.length,0);
});

test('wrong page, stale cursor and arbitrary operation arguments are rejected',async()=>{
  const {mock,page,set}=fixture();
  mock.figma.fileKey='other';
  await assert.rejects(run(mock,buildCatalogInventoryCode,{fileKey:'target'}),/Неверный целевой файл/);
  mock.figma.fileKey='target';
  await assert.rejects(run(mock,buildCatalogExampleCode,{fileKey:'target',pageId:mock.page.id,nodeId:set.id}),/вне pageId/);
  await assert.rejects(run(mock,buildCatalogPageCode,{fileKey:'target',pageId:mock.page.id,nodeId:set.id,mode:'roles'}),/вне pageId/);
  await assert.rejects(run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest',cursor:'1:deadbeef'}),/Курсор устарел/);
  assert.equal(catalogPageSchema.safeParse({fileKey:'target',pageId:page.id,mode:'resources',componentIds:[set.id,set.id],manifestFingerprint:'abcd'}).success,false);
  assert.equal(catalogExampleSchema.safeParse({fileKey:'target',pageId:page.id,nodeId:set.id,script:'figma.setCurrentPageAsync()'}).success,false);
  assert.equal(mock.writes.length,0);
});

test('diagnostics describe full-page work for one selected component without canvas text',async()=>{
  const {mock,page,first,label}=fixture();
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  const result=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'resources',componentIds:[first.id],manifestFingerprint:manifest.manifestFingerprint});
  assert.equal(result.catalogDiagnostics.phase,'complete');
  assert.ok(result.catalogDiagnostics.timings.fullTreeMs>=0);
  assert.ok(result.catalogDiagnostics.timings.selectedDescendantsMs>=0);
  assert.ok(result.catalogDiagnostics.counts.treeNodes>result.catalogDiagnostics.counts.selectedComponents);
  assert.equal(JSON.stringify(result.catalogDiagnostics).includes(label.characters),false);
  const plain=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  assert.equal(plain.catalogDiagnostics.phase,'complete');
});

test('native resource timeout aborts batch with diagnostics instead of reporting a complete gap',async()=>{
  const {mock,page,first}=fixture();
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  first.getPublishStatusAsync=async()=>new Promise(()=>{});
  await assert.rejects(run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'resources',componentIds:[first.id],manifestFingerprint:manifest.manifestFingerprint}),error=>{
    assert.equal(error.code,'FIGMA_READ_TIMEOUT');
    assert.equal(error.catalogDiagnostics.phase,'componentPublishStatus');
    assert.equal(error.operationStatus,'not_applied');
    return true;
  });
});

test('cancelled resource read aborts batch instead of reporting a complete gap',async()=>{
  const {mock,page,first}=fixture();
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  const control={cancelled:false};
  first.getPublishStatusAsync=async()=>{control.cancelled=true;return 'CURRENT';};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await assert.rejects(new AsyncFunction('figma','executionControl',buildCatalogPageCode({fileKey:'target',pageId:page.id,mode:'resources',componentIds:[first.id],manifestFingerprint:manifest.manifestFingerprint}))(mock.figma,control),error=>{
    assert.equal(error.code,'OPERATION_CANCELLED');
    assert.equal(error.catalogDiagnostics.phase,'componentPublishStatus');
    return true;
  });
});

test('deprecated variable still counts as an attempted native read before a later timeout',async()=>{
  const {mock,page,first,label}=fixture();
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  mock.variables.get('var:1').name='DEPRECATED size';
  mock.addVariable({id:'var:2',name:'Next size'});
  label.boundVariables={fontSize:{type:'VARIABLE_ALIAS',id:'var:1'},lineHeight:{type:'VARIABLE_ALIAS',id:'var:2'}};
  const original=mock.figma.variables.getVariableByIdAsync;
  mock.figma.variables.getVariableByIdAsync=id=>id==='var:2'?new Promise(()=>{}):original(id);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const fastTimer=(fn,ms)=>setTimeout(fn,ms===6000?5:ms);
  await assert.rejects(new AsyncFunction('figma','setTimeout',buildCatalogPageCode({fileKey:'target',pageId:page.id,mode:'resources',componentIds:[first.id],manifestFingerprint:manifest.manifestFingerprint}))(mock.figma,fastTimer),error=>{
    assert.equal(error.code,'FIGMA_READ_TIMEOUT');
    assert.equal(error.catalogDiagnostics.phase,'variables');
    assert.equal(error.catalogDiagnostics.counts.attemptedVariables,2);
    return true;
  });
});

test('deprecated style still counts as an attempted native read before a later API error',async()=>{
  const {mock,page,first,label}=fixture();
  const manifest=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'manifest'});
  mock.styles[0].name='DEPRECATED typography';
  label.textStyleId='style:2';
  const original=mock.figma.getStyleByIdAsync;
  mock.figma.getStyleByIdAsync=id=>id==='style:2'?Promise.reject(Error('offline')):original(id);
  const result=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:page.id,mode:'resources',componentIds:[first.id],manifestFingerprint:manifest.manifestFingerprint});
  assert.equal(result.complete,true);
  assert.ok(result.gaps.some(gap=>gap.kind==='style'&&gap.id==='style:2'));
  assert.equal(result.catalogDiagnostics.counts.attemptedStyles,2);
});

test('wide page snapshots children once during full-tree scan instead of repeatedly materializing the native array',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const children=[];
  for(let i=0;i<14340;i++)children.push(mock.make('RECTANGLE',{name:'Item '+i},null));
  const component=mock.make('COMPONENT',{name:'Last',key:'last'},null);children.push(component);
  for(const child of children)child.parent=mock.page;
  let reads=0;
  Object.defineProperty(mock.page,'children',{get(){reads++;return children;},configurable:true});
  const result=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:mock.page.id,mode:'manifest'});
  assert.deepEqual(result.componentIds,[component.id]);
  assert.equal(result.catalogDiagnostics.counts.treeNodes,14342);
  assert.equal(reads,1,'native children must be snapshotted once for the traversal');
});

test('full-tree yield records scheduler delay without changing traversal coverage',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const children=Array.from({length:4100},()=>mock.make('RECTANGLE',{},null));
  mock.page.children=children;for(const child of children)child.parent=mock.page;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  let now=1000;
  const Clock=class extends Date {static now(){return now;}};
  const timer=(fn,delay)=>{if(delay===0){now+=17;queueMicrotask(fn);return 0;}return setTimeout(fn,delay);};
  const result=await new AsyncFunction('figma','setTimeout','Date',buildCatalogPageCode({fileKey:'target',pageId:mock.page.id,mode:'manifest'}))(mock.figma,timer,Clock);
  assert.equal(result.catalogDiagnostics.counts.treeNodes,4101);
  assert.equal(result.catalogDiagnostics.counts.treeYieldCount,2);
  assert.equal(result.catalogDiagnostics.counts.treeYieldWaitMs,34);
  assert.equal(result.catalogDiagnostics.counts.treeYieldPending,0);
  assert.equal(result.catalogDiagnostics.timings.fullTreeMs,34);
});

test('cancellation while yielding stops before touching the next Figma node',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const children=Array.from({length:2050},()=>mock.make('RECTANGLE',{},null));
  mock.page.children=children;for(const child of children)child.parent=mock.page;
  let touchedAfterCancel=0;
  Object.defineProperty(children[2047],'children',{get(){touchedAfterCancel++;return [];},configurable:true});
  const control={cancelled:false};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const timer=(fn,delay)=>{if(delay===0){control.cancelled=true;queueMicrotask(fn);return 0;}return setTimeout(fn,delay);};
  await assert.rejects(new AsyncFunction('figma','executionControl','setTimeout',buildCatalogPageCode({fileKey:'target',pageId:mock.page.id,mode:'manifest'}))(mock.figma,control,timer),{code:'OPERATION_CANCELLED'});
  assert.equal(touchedAfterCancel,0);
});

test('large roles scan preserves exact coverage and rejects a file switch during yield',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  for(let i=0;i<14340;i++)mock.make('RECTANGLE',{},mock.page);
  const component=mock.make('COMPONENT',{name:'Last',key:'last'},mock.page);
  const result=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:mock.page.id,mode:'roles'});
  assert.deepEqual(result.componentIds,[component.id]);
  assert.equal(result.complete,true);
  assert.equal(result.catalogDiagnostics.counts.treeNodes,14342);
  assert.equal(mock.figma.currentPage,mock.page);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const control={cancelled:false};let pending;
  const timer=(fn,delay)=>{if(delay===0){pending??=control.catalogDiagnosticsSnapshot();mock.figma.fileKey='other';queueMicrotask(fn);return 0;}return setTimeout(fn,delay);};
  await assert.rejects(new AsyncFunction('figma','executionControl','setTimeout',buildCatalogPageCode({fileKey:'target',pageId:mock.page.id,mode:'roles'}))(mock.figma,control,timer),/Целевой файл изменился/);
  assert.equal(pending.phase,'fullTree');
  assert.equal(pending.counts.treeYieldPending,1);
  assert.equal(pending.counts.treeNodesVisited,2048);
});

test('branched large roles preserve all tagged roles and stable fingerprints; empty page has no roles',async()=>{
  const mock=createFigmaMock();mock.figma.fileKey='target';
  const set=mock.make('COMPONENT_SET',{id:'set-z',name:'Set'},mock.page);
  mock.make('COMPONENT',{id:'component-b',name:'B'},set);
  mock.make('COMPONENT',{id:'component-a',name:'A'},set);
  const frame=mock.make('FRAME',{id:'frame-a',name:'Example'},mock.page);
  mock.make('TEXT',{characters:'Text'},frame);
  const filler=mock.make('FRAME',{name:'Empty branch'},mock.page);
  const children=Array.from({length:14340},()=>mock.make('RECTANGLE',{},null));
  filler.children=children;for(const node of children)node.parent=filler;
  const parts=[];let cursor;
  do {const part=await run(mock,buildCatalogPageCode,{fileKey:'target',pageId:mock.page.id,mode:'roles',limit:2,...(cursor?{cursor}:{})});parts.push(part);cursor=part.nextCursor;}while(cursor);
  assert.deepEqual(parts.flatMap(p=>p.componentIds),['component-a','component-b','set-z']);
  assert.deepEqual(parts.flatMap(p=>p.exampleCandidates),[
    {id:'frame-a',name:'Example',type:'FRAME'},
    {id:'set-z',name:'Set',type:'COMPONENT_SET',variantIds:['component-a','component-b']},
  ]);
  assert.deepEqual(parts.map(p=>p.coverage.returned),[2,2,1]);
  assert.deepEqual(parts.map(p=>p.total),[5,5,5]);
  assert.equal(new Set(parts.map(p=>p.fingerprint)).size,1);
  assert.equal(parts[0].fingerprint,'d52f2e5d');
  assert.equal(parts.at(-1).complete,true);
  const empty=createFigmaMock();empty.figma.fileKey='target';
  const result=await run(empty,buildCatalogPageCode,{fileKey:'target',pageId:empty.page.id,mode:'roles'});
  assert.deepEqual(result.componentIds,[]);assert.deepEqual(result.exampleCandidates,[]);
  assert.equal(result.total,0);assert.equal(result.complete,true);assert.equal(result.nextCursor,null);
});
