import test from 'node:test';
import assert from 'node:assert/strict';
import {buildUseComponentCode} from '../src/figma-code.mjs';
import {createFigmaMock} from './helpers/figma-mock.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
for(const route of ['library','local-variant','set'])test('dryRun variant definitions from parent set: '+route,async()=>{
 const mock=createFigmaMock(),defs={Size:{type:'VARIANT',defaultValue:'m',variantOptions:['m']}};
 const set=mock.make('COMPONENT_SET',{componentPropertyDefinitions:defs});
 const component=mock.make('COMPONENT',{key:'library-variant',variantProperties:{Size:'m'}},set);
 Object.defineProperty(component,'componentPropertyDefinitions',{get(){throw Error('Can only get component property definitions of a component set or non-variant component');}});
 let imports=0; mock.figma.importComponentByKeyAsync=async()=>{imports++;return component;};
 mock.writes.length=0; const count=mock.nodes.size;
 const args={key:'target/component',dryRun:true,screenshot:false,...(route==='library'?{libraryKey:'library-variant'}:{sourceId:route==='set'?set.id:component.id}),...(route==='set'?{variant:{Size:'m'}}:{})};
 const result=await new AsyncFunction('figma',buildUseComponentCode(args))(mock.figma);
 assert.equal(result.ready,true);assert.equal(result.sourceId,component.id);assert.deepEqual(result.componentPropertyDefinitions,defs);
 assert.equal(imports,route==='library'?1:0);assert.equal(mock.nodes.size,count);assert.equal(mock.writes.length,0);
});
test('dryRun preserves standalone component definitions',async()=>{
 const mock=createFigmaMock(),defs={Label:{type:'TEXT',defaultValue:'text'}},component=mock.make('COMPONENT',{key:'standalone',componentPropertyDefinitions:defs});
 const result=await new AsyncFunction('figma',buildUseComponentCode({key:'target/component',sourceId:component.id,dryRun:true,screenshot:false}))(mock.figma);
 assert.deepEqual(result.componentPropertyDefinitions,defs);assert.equal(result.sourceId,component.id);
});
