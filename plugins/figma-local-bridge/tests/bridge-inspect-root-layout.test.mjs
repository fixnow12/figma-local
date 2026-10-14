/** Synthetic API nodes: execute actual full-inspection generation, no native call.
 * Clean bundles may bind an existing real Zod via BRIDGE_TEST_ZOD_MODULE.
 */
import test from 'node:test';import assert from 'node:assert/strict';
import * as modules from 'node:module';import {pathToFileURL} from 'node:url';
let hook;
if(process.env.BRIDGE_TEST_ZOD_MODULE){assert.equal(typeof modules.registerHooks,'function','Local dependency binding needs registerHooks');hook=modules.registerHooks({resolve(specifier,context,next){return specifier==='zod'?{url:pathToFileURL(process.env.BRIDGE_TEST_ZOD_MODULE).href,shortCircuit:true}:next(specifier,context);}});}
const {buildInspectCode}=await import('../src/figma-code.mjs');hook?.deregister();
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function inspect(fields,detail='full'){
 const node={id:'1:2',name:'Synthetic root',type:'FRAME',visible:true,x:0,y:0,width:100,height:40,fills:[],strokes:[],effects:[],children:[],resolvedVariableModes:{},...fields};
 const before=structuredClone(node),figma={mixed:Symbol('mixed'),currentPage:{id:'0:1',name:'Synthetic page',selection:[node]},getNodeByIdAsync:async id=>id===node.id?node:null};
 const result=await new AsyncFunction('figma',buildInspectCode({nodeIds:[node.id],detail,depth:1,maxNodes:2}))(figma);
 assert.deepEqual(node,before);assert.equal(result.coverage.complete,true);assert.deepEqual(result.coverage.unread,[]);assert.equal(result.inspectedNodes,1);
 return JSON.parse(JSON.stringify(result)).selection[0];
}
for(const [grow,align]of [[0,'INHERIT'],[1,'STRETCH']])test('full inspection retains exact present layoutGrow '+grow+' and layoutAlign '+align,async()=>{const observed=await inspect({layoutGrow:grow,layoutAlign:align});assert.equal(observed.layoutGrow,grow);assert.equal(observed.layoutAlign,align);});
test('each root-layout observation is captured independently',async()=>{const grow=await inspect({layoutGrow:0}),align=await inspect({layoutAlign:'CENTER'});assert.equal(grow.layoutGrow,0);assert.equal(Object.hasOwn(grow,'layoutAlign'),false);assert.equal(align.layoutAlign,'CENTER');assert.equal(Object.hasOwn(align,'layoutGrow'),false);});
test('absent root-layout observations remain absent with no defaults',async()=>{const observed=await inspect({});assert.equal(Object.hasOwn(observed,'layoutGrow'),false);assert.equal(Object.hasOwn(observed,'layoutAlign'),false);});
test('summary detail keeps full-only root-layout observations omitted',async()=>{const observed=await inspect({layoutGrow:1,layoutAlign:'STRETCH'},'summary');assert.equal(Object.hasOwn(observed,'layoutGrow'),false);assert.equal(Object.hasOwn(observed,'layoutAlign'),false);});
