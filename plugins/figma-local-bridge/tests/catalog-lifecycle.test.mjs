import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFigmaMock} from './helpers/figma-mock.mjs';
import {buildCatalogPageCode} from '../src/catalog-read.mjs';
import {normalizeComponentVariantGroups} from '../src/component-definitions.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
function fixture(size=0){const m=createFigmaMock();m.figma.fileKey='target';let loads=0;m.page.loadAsync=async()=>{loads++;};for(let i=0;i<size;i++)m.make('RECTANGLE',{},m.page);const c=m.make('COMPONENT',{key:'component',getPublishStatusAsync:async()=> 'CURRENT'},m.page);const r={ready:true,generation:0,sessionId:'fixture',sessions:new Map(),invalidated:new Map()};return {m,c,r,args:{fileKey:'target',pageId:m.page.id,traversalId:'snapshot',mode:'manifest'},loads:()=>loads};}
function run(f,args=f.args){return new AsyncFunction('figma','executionControl',buildCatalogPageCode(args))(f.m.figma,{cancelled:false,catalogTraversal:f.r});}
async function finish(f){let row=await run(f);while(!row.complete)row=await run(f,{...f.args,cursor:row.nextCursor});return row;}
// Execute the unchanged production listener's classification/invalidation block.
const plugin=readFileSync(new URL('../src/figma-plugin/code.js',import.meta.url),'utf8');
const start=plugin.indexOf('    // Retain global epoch semantics:'),end=plugin.indexOf('    // Observational only:',start);
assert(start>0&&end>start);
const classify=new Function('figma','catalogTraversalRegistry','event',plugin.slice(start,end));
function change(f,node,properties=['name']){classify(f.m.figma,f.r,{documentChanges:[{type:'PROPERTY_CHANGE',id:node.id,node,properties}]});}
test('resumed manifest, roles and resource requests reuse one loaded page snapshot',async()=>{
 const f=fixture(1000),manifest=await finish(f);assert.equal(f.loads(),1);
 await run(f,{...f.args,mode:'roles'});await run(f,{...f.args,mode:'resources',componentIds:[f.c.id],manifestFingerprint:manifest.manifestFingerprint,requireExistingSnapshot:true});assert.equal(f.loads(),1);
});
test('lost snapshot and foreign resume fail before another page load',async()=>{
 const f=fixture(1000),first=await run(f);assert.equal(f.loads(),1);f.r.sessions.clear();
 await assert.rejects(run(f,{...f.args,cursor:first.nextCursor}),e=>e.code==='CATALOG_CURSOR_INVALID'&&e.catalogSource.reason==='snapshot-missing');assert.equal(f.loads(),1);
});
test('same-page document event invalidates with a retained reason and rejects resume without reload',async()=>{
 const f=fixture(1000),first=await run(f);change(f,f.m.page.children[0]);
 assert.equal(f.r.generation,1);assert.equal(f.r.sessions.size,0);assert.equal(f.r.lastDocumentChange.reason,'closure-exception');assert.equal(f.r.lastDocumentChange.failureCondition,'ancestry-recorded-node');
 await assert.rejects(run(f,{...f.args,cursor:first.nextCursor}),e=>e.code==='CATALOG_TRAVERSAL_INVALIDATED'&&e.catalogSource.reason==='document-change'&&e.catalogSource.lastInvalidation.diagnostic.failureCondition==='ancestry-recorded-node');assert.equal(f.loads(),1);
});
test('proved independent local change on another page preserves saved traversal',async()=>{
 const f=fixture();await finish(f);const other=f.m.make('PAGE',{},null);f.m.figma.root.children.push(other);const node=f.m.make('TEXT',{characters:'Other'},other);change(f,node,['characters']);
 assert.equal(f.r.generation,0);assert.equal(f.r.sessions.size,1);assert.equal(f.r.lastDocumentChange.reason,'proved-independent');
});
test('cross-page instance dependency and unsupported style change invalidate',async()=>{
 for(const kind of ['INSTANCE','STYLE']){const f=fixture();await finish(f);const other=f.m.make('PAGE',{},null);f.m.figma.root.children.push(other);const node=f.m.make(kind==='STYLE'?'TEXT':kind,{},other);change(f,node,kind==='STYLE'?['textStyleId']:['name']);assert.equal(f.r.generation,1);assert.equal(f.r.sessions.size,0);assert.notEqual(f.r.lastDocumentChange.reason,'proved-independent');}
});
test('page events must reach a quiet interval; continuous change never creates a snapshot',async()=>{
 for(const continuous of [false,true]){
  const f=fixture();let now=1000,calls=0;
  const timer=(fn,ms)=>{if(ms===10){now+=10;calls++;if(continuous||calls<=3){f.r.generation++;f.r.lastDocumentChange={at:now};}queueMicrotask(fn);return 0;}return setTimeout(fn,ms);};
  const promise=new AsyncFunction('figma','executionControl','Date','setTimeout',buildCatalogPageCode(f.args))(f.m.figma,{cancelled:false,catalogTraversal:f.r},{now:()=>now},timer);
  if(continuous){await assert.rejects(promise,{code:'CATALOG_PAGE_NOT_QUIET'});assert.equal(f.r.sessions.size,0);assert.equal(calls,25);}else{assert.equal((await promise).complete,true);assert.equal(f.r.generation,3);assert.equal(calls,8);}
  assert.equal(f.loads(),1);
 }
});
test('SLOT metadata remains outside variant axes while malformed slot settings fail',()=>{
 const definitions={State:{type:'VARIANT',defaultValue:'Default',variantOptions:['Default','Hover']},Content:{type:'SLOT',description:'Content',slotSettings:{minChildren:0,maxChildren:2,stretchChildOnInsert:true},preferredValues:[{type:'COMPONENT',key:'a'.repeat(40)}]}};
 const before=structuredClone(definitions);assert.deepEqual(normalizeComponentVariantGroups(definitions),{State:{values:['Default','Hover']}});assert.deepEqual(definitions,before);
 for(const patch of [{slotSettings:{minChildren:3,maxChildren:1}},{slotSettings:{allowPreferredValuesOnly:'yes'}},{variantOptions:['x']},{preferredValues:[{type:'FRAME',key:'x'}]}])assert.throws(()=>normalizeComponentVariantGroups({...definitions,Content:{...definitions.Content,...patch}}),/Invalid SLOT/);
});
