import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
import {buildInspectCode} from '../src/figma-code.mjs';
const read=(m,n,detail='full')=>executeGenerated(m.figma,buildInspectCode({nodeId:n.id,detail,depth:8,maxNodes:100}));
test('full inspection preserves actual vector vertex caps and joins without writes',async()=>{
 const m=createFigmaMock(),network={vertices:[{x:0,y:0,strokeCap:'ROUND',strokeJoin:'BEVEL'},{x:10,y:0,strokeCap:'SQUARE',strokeJoin:'ROUND'}],segments:[{start:0,end:1}],regions:[]};
 const n=m.make('VECTOR',{vectorNetwork:network,strokeCap:m.figma.mixed,strokeJoin:m.figma.mixed});m.writes.length=0;
 const r=await read(m,n);assert.deepEqual(r.selection[0].vectorNetwork,network);assert.equal(r.selection[0].strokeCap,'MIXED');assert.equal(r.selection[0].strokeJoin,'MIXED');assert.equal(m.writes.length,0);
});
test('full inspection resolves inherited modes to actual collection identity and modes',async()=>{
 const m=createFigmaMock(),c={id:'collection-local',key:'a'.repeat(40),defaultModeId:'day',modes:[{modeId:'day',name:'Day'},{modeId:'night',name:'Night'}]};
 m.figma.variables.getVariableCollectionByIdAsync=async id=>id===c.id?c:null;
 const n=m.make('FRAME',{resolvedVariableModes:{[c.id]:'night'},explicitVariableModes:{}});m.writes.length=0;
 const r=await read(m,n);assert.deepEqual(r.selection[0].resolvedVariableModes,{[c.id]:'night'});assert.deepEqual(r.variableCollections,[c]);assert.equal(m.writes.length,0);
});
test('missing collection or selected mode fails instead of returning complete evidence',async()=>{
 for(const c of [null,{id:'c',key:'b'.repeat(40),modes:[{modeId:'other',name:'Other'}]}]){
  const m=createFigmaMock();m.figma.variables.getVariableCollectionByIdAsync=async()=>c;
  const n=m.make('FRAME',{resolvedVariableModes:{c:'wanted'}});await assert.rejects(read(m,n),/mode|collection/i);
 }
});
test('compact inspection does not read full vector or inherited-mode fields',async()=>{
 const m=createFigmaMock(),n=m.make('VECTOR');for(const f of ['vectorNetwork','resolvedVariableModes'])Object.defineProperty(n,f,{get(){throw Error('unexpected full getter');}});
 const r=await read(m,n,'compact');assert.equal('vectorNetwork'in r.selection[0],false);assert.equal('variableCollections'in r,false);
});

test('full inspection retains independent primary and counter axis sizing modes without writes',async()=>{
 const m=createFigmaMock(),n=m.make('FRAME',{primaryAxisSizingMode:'AUTO',counterAxisSizingMode:'FIXED'});m.writes.length=0;
 const r=await read(m,n);assert.equal(r.selection[0].primaryAxisSizingMode,'AUTO');assert.equal(r.selection[0].counterAxisSizingMode,'FIXED');assert.equal(m.writes.length,0);
});
