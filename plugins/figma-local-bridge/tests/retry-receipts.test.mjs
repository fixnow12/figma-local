import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {OperationJournal} from '../src/operation-journal.mjs';
import {buildRenderCode, buildInspectCode} from '../src/figma-code.mjs';
import {createFigmaMock, executeGenerated} from './helpers/figma-mock.mjs';
for (const type of ['FRAME','SECTION']) test(`target ${type}: actual ancestry and replacement preserve Master`, async()=>{
 const m=createFigmaMock(), master=m.make(type, {name:'Master'}, m.page);
 const input={parentId:master.id,spec:{key:'new',name:'New',type:'screen',width:300,height:200,children:[]},replace:true};
 const first=await executeGenerated(m.figma,buildRenderCode(input));
 const r=await executeGenerated(m.figma,buildRenderCode(input));
 assert.equal(m.nodes.has(first.rootId),false);assert.equal(m.nodes.has(master.id),true);
 assert.equal(m.nodes.get(r.sectionId).parent,master);
 assert.equal(r.placement.destinationParentId,master.id);assert.equal(r.placement.wrapperType,type);
 const read=await executeGenerated(m.figma,buildInspectCode({nodeId:r.sectionId,depth:2,detail:'full',maxNodes:100}));
 assert.equal(read.selection[0].parentId,master.id);assert.equal(read.selection[0].children[0].parentId,r.sectionId);
});
test('invalid or other-page parent fails before creation, including dryRun',async()=>{
 const m=createFigmaMock(), other=m.make('PAGE'), master=m.make('FRAME',{},other);
 for(const parentId of ['missing',master.id,m.make('TEXT',{},m.page).id]){
  const before=m.nodes.size;
  for(const dryRun of [true,false]) await assert.rejects(executeGenerated(m.figma,buildRenderCode({parentId,dryRun,spec:{key:'x',name:'x',width:10,height:10,children:[]}})),/parentId/);
  assert.equal(m.nodes.size,before);
 }
});
for(const status of ['partial','unknown']) test(`${status}: durable repeatable read, retry identity and intentional new edit`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-'));
 try{
 const j=new OperationJournal(dir),input={fileKey:'file',operationId:randomUUID(),name:'patch_nodes',args:{patches:[{key:'root',append:[{key:'a'}]}]}};
 const r=j.begin(input,'socket');j.mark(r.operationId,{commandSent:true,state:'unknown',operationStatus:'unknown'});
 assert.throws(()=>j.begin({...input,operationId:randomUUID()},'socket'),{code:'OPERATION_IN_PROGRESS'});
 assert.equal(j.event('socket',{operationId:r.operationId,fileKey:r.fileKey,argsHash:r.argsHash,sequence:1,stage:'settled',success:false,operationStatus:status,error:'real failure',rollbackErrors:['a']}),true);
 const fresh=new OperationJournal(dir);
 for(let i=0;i<3;i++){const s=fresh.get('file',r.operationId);assert.equal(s.operationStatus,status);assert.equal(s.error.message,'real failure');assert.deepEqual(s.error.rollbackErrors,['a']);}
 assert.throws(()=>fresh.begin(input,'socket'),{code:'OPERATION_ALREADY_EXISTS'});
 assert.ok(fresh.begin({...input,operationId:randomUUID()},'socket'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('late settled success retains IDs after timeout',()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-'));
 try{
 const j=new OperationJournal(dir),r=j.begin({fileKey:'file',name:'render_screen',args:{spec:{key:'root'}}},'socket');
 j.mark(r.operationId,{state:'unknown',operationStatus:'unknown',commandSent:true});
 assert.equal(j.event('socket',{operationId:r.operationId,fileKey:r.fileKey,argsHash:r.argsHash,sequence:1,stage:'settled',success:true,result:{rootId:'1:2',sectionId:'1:3'}}),true);
 assert.equal(new OperationJournal(dir).get('file',r.operationId).result.rootId,'1:2');assert.equal(j.get('file',r.operationId).operationStatus,'applied');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('target rejects attach: wrapper is tracked and rolled back without orphan',async()=>{
 const m=createFigmaMock(),parent=m.make('FRAME',{},m.page),before=m.nodes.size;
 parent.appendChild=()=>{throw Error('cannot attach');};
 await assert.rejects(executeGenerated(m.figma,buildRenderCode({parentId:parent.id,spec:{key:'x',name:'x',width:10,height:10,children:[]}})),/cannot attach/);
 assert.equal(m.nodes.size,before);
});
test('response before terminal receipt still acknowledges relay without overwriting result',()=>{
 const dir=mkdtempSync(join(tmpdir(),'receipt-race-'));
 try{
 const j=new OperationJournal(dir),r=j.begin({fileKey:'file',name:'patch_nodes',args:{}},'socket');
 j.mark(r.operationId,{settled:true,state:'verified',operationStatus:'applied',receiptPending:true,result:{rootId:'saved'}});
 const e={operationId:r.operationId,fileKey:r.fileKey,argsHash:r.argsHash,sequence:1,stage:'settled',success:true,result:{rootId:'late'}};
 assert.equal(j.event('foreign',e),false);assert.equal(j.event('socket',e),true);
 assert.equal(j.acknowledged('socket',e),true);assert.equal(j.get('file',r.operationId).result.rootId,'saved');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
