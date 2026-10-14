/** Synthetic Plugin API nodes only; execute the real generated inspection code.
 * A clean bundle can use BRIDGE_TEST_ZOD_MODULE to bind a local Zod installation
 * without installing or changing the packaged Bridge. No schema mock is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as modules from 'node:module';
import {pathToFileURL} from 'node:url';
let hook;
if(process.env.BRIDGE_TEST_ZOD_MODULE){
 assert.equal(typeof modules.registerHooks,'function','Local dependency binding needs Node with registerHooks');
 hook=modules.registerHooks({resolve(specifier,context,next){return specifier==='zod'?{url:pathToFileURL(process.env.BRIDGE_TEST_ZOD_MODULE).href,shortCircuit:true}:next(specifier,context);}});
}
const {buildInspectCode}=await import('../src/figma-code.mjs');
hook?.deregister();
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function inspect(fields,detail='full'){
 const node={id:'1:2',name:'Synthetic node',type:'FRAME',visible:true,x:0,y:0,width:120,height:48,opacity:1,fills:[],strokes:[],effects:[],children:[],resolvedVariableModes:{},...fields};
 const before=structuredClone(node),page={id:'0:1',name:'Synthetic page',selection:[node]},figma={currentPage:page,mixed:Symbol('mixed'),getNodeByIdAsync:async id=>id===node.id?node:null};
 const result=await new AsyncFunction('figma',buildInspectCode({nodeIds:[node.id],detail,depth:2,maxNodes:10}))(figma);
 assert.deepEqual(node,before);assert.equal(result.coverage.complete,true);assert.deepEqual(result.coverage.unread,[]);assert.equal(result.inspectedNodes,1);
 return JSON.parse(JSON.stringify(result)).selection[0];
}
const grids=[{pattern:'COLUMNS',alignment:'STRETCH',gutterSize:16,count:12,offset:24,color:{r:1,g:0,b:0,a:0.1},visible:true},{pattern:'GRID',sectionSize:8,color:{r:0,g:0,b:1,a:0.05},visible:false}];
test('full inspect serializes exact present layout grids and native style ID',async()=>{
 const observed=await inspect({layoutGrids:grids,gridStyleId:'S:synthetic-grid-style,1'});
 assert.deepEqual(observed.layoutGrids,grids);assert.equal(observed.gridStyleId,'S:synthetic-grid-style,1');
});
test('full inspect preserves empty layout grids and empty gridStyleId observations',async()=>{
 const observed=await inspect({layoutGrids:[],gridStyleId:''});assert.deepEqual(observed.layoutGrids,[]);assert.equal(observed.gridStyleId,'');
});
test('full inspect leaves absent grid fields absent instead of inventing defaults',async()=>{
 const observed=await inspect({});assert.equal(Object.hasOwn(observed,'layoutGrids'),false);assert.equal(Object.hasOwn(observed,'gridStyleId'),false);
});
test('each present grid field is captured independently',async()=>{
 const grid=await inspect({layoutGrids:grids}),style=await inspect({gridStyleId:'S:synthetic-only,2'});
 assert.deepEqual(grid.layoutGrids,grids);assert.equal(Object.hasOwn(grid,'gridStyleId'),false);
 assert.equal(style.gridStyleId,'S:synthetic-only,2');assert.equal(Object.hasOwn(style,'layoutGrids'),false);
});
test('summary detail retains existing omission of full-only grid fields',async()=>{
 const observed=await inspect({layoutGrids:grids,gridStyleId:'S:synthetic-grid-style,1'},'summary');assert.equal(Object.hasOwn(observed,'layoutGrids'),false);assert.equal(Object.hasOwn(observed,'gridStyleId'),false);
});
