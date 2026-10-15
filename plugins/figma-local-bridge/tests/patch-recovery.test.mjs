import test from 'node:test';
import assert from 'node:assert/strict';
import {operationArgsHash} from '../src/operation-journal.mjs';
import {planPatchRecovery} from '../src/patch-recovery.mjs';
const args={fileKey:'file',patches:[{id:'root',append:[{key:'a',type:'frame',name:'A'},{key:'b',parentKey:'a',type:'text',name:'B',content:'B'},{key:'c',type:'frame',name:'C'}]}]};
const operation={operationId:'receipt',fileKey:'file',name:'patch_nodes',operationInput:args,settled:true,operationStatus:'partial',argsHash:operationArgsHash({fileKey:'file',name:'patch_nodes',args})};
const readback={operationStatus:'read',fileContext:{fileKey:'file'},result:{coverage:{complete:true,unread:[]},selection:[{id:'root',children:[{id:'a',key:'a',type:'FRAME',parentId:'root',children:[]}]}]}};
test('partial append proposes only absent nodes under actual parents; repeated reads do not mutate evidence',()=>{
 const snapshot=JSON.stringify({operation,readback});
 for(let i=0;i<3;i++){
 const p=planPatchRecovery({operation,readback});assert.deepEqual(p.existingKeys,['a']);
 assert.deepEqual(p.next.patches,[{id:'a',append:[{key:'b',type:'text',name:'B',content:'B'}]},{id:'root',append:[{key:'c',type:'frame',name:'C'}]}]);
 }
 assert.equal(JSON.stringify({operation,readback}),snapshot);
});
test('all present proposes no write, including settled unknown',()=>{
 const r=structuredClone(readback);r.result.selection[0].children[0].children=[{id:'b',key:'b',type:'TEXT',parentId:'a'}];r.result.selection[0].children.push({id:'c',key:'c',type:'FRAME',parentId:'root'});
 assert.equal(planPatchRecovery({operation:{...operation,operationStatus:'unknown'},readback:r}).next,null);
});
test('in-flight unknown, incomplete/foreign reads and wrong parent cannot resume',()=>{
 assert.throws(()=>planPatchRecovery({operation:{...operation,settled:false},readback}),/settle/);
 for(const change of [r=>r.result.coverage.complete=false,r=>r.fileContext.fileKey='foreign',r=>r.result.selection[0].children[0].parentId='other',r=>r.result.selection[0].children[0].type='TEXT']){
 const r=structuredClone(readback);change(r);assert.throws(()=>planPatchRecovery({operation,readback:r}));
 }
});
