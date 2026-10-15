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

test('UUID case is one operation across create/get/event/mark/reload and stale journal instances',()=>{
 const dir=mkdtempSync(join(tmpdir(),'uuid-case-'));
 try{
 const lower='aabbccdd-abcd-4abc-aabc-aabbccddeeff',upper=lower.toUpperCase();
 const j=new OperationJournal(dir),stale=new OperationJournal(dir);
 const input={fileKey:'file',name:'patch_nodes',operationId:upper,args:{operationId:upper,patches:[]}};
 const r=j.begin(input,'socket');assert.equal(r.operationId,lower);
 assert.equal(j.get('file',upper).operationId,lower);
 j.mark(upper,{settled:true,state:'failed',operationStatus:'not_applied',code:'SAME'});
 assert.throws(()=>j.begin({...input,operationId:lower,args:{...input.args,operationId:lower}},'socket'),{code:'OPERATION_ALREADY_EXISTS'});
 assert.throws(()=>stale.begin({...input,operationId:lower},'other'),{code:'OPERATION_ALREADY_EXISTS'});
 assert.equal(j.event('socket',{operationId:upper,fileKey:'file',argsHash:r.argsHash,stage:'settled',sequence:1,success:false,operationStatus:'not_applied',code:'SAME'}),true);
 assert.equal(j.acknowledged('socket',{operationId:upper,fileKey:'file',argsHash:r.argsHash,sequence:1}),true);
 const fresh=new OperationJournal(dir);assert.equal(fresh.get('file',upper).sequence,1);
 assert.equal(fresh.get('file',lower).code,'SAME');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('matching late terminal error receipt is ACKed without replacing saved outcome',()=>{
 const dir=mkdtempSync(join(tmpdir(),'error-receipt-'));
 try{
 const j=new OperationJournal(dir),r=j.begin({fileKey:'file',name:'render_screen',args:{}},'socket');
 j.mark(r.operationId,{settled:true,state:'failed',operationStatus:'not_applied',error:{code:'EXPIRED',message:'original failure'}});
 const e={operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:1,stage:'settled',success:false,operationStatus:'not_applied',code:'EXPIRED',error:'late error'};
 assert.equal(j.event('foreign',e),false);assert.equal(j.event('socket',{...e,code:'DIFFERENT'}),false);
 assert.equal(j.event('socket',e),true);assert.equal(j.acknowledged('socket',e),true);
 assert.equal(j.event('socket',e),false);assert.equal(j.acknowledged('socket',e),true);
 assert.equal(j.get('file',r.operationId).error.message,'original failure');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Master moved during font await is rejected before any creation',async()=>{
 const m=createFigmaMock(),master=m.make('FRAME',{},m.page),other=m.make('PAGE');
 const before=m.nodes.size;
 m.figma.loadFontAsync=async()=>{other.appendChild(master);};
 await assert.rejects(executeGenerated(m.figma,buildRenderCode({parentId:master.id,spec:{key:'x',name:'X',width:20,height:20,children:[{key:'t',type:'text',name:'T',content:'X'}]}})),/parentId/);
 assert.equal(m.nodes.size,before);
});
test('Master moved during finalization rolls back new render and preserves replaced root',async()=>{
 const m=createFigmaMock(),master=m.make('FRAME',{},m.page),other=m.make('PAGE');
 const input={parentId:master.id,replace:true,spec:{key:'x',name:'X',width:20,height:20,children:[]}};
 const previous=await executeGenerated(m.figma,buildRenderCode(input));const before=m.nodes.size;
 await assert.rejects(executeGenerated(m.figma,buildRenderCode({...input,finalizeCode:`(await figma.getNodeByIdAsync(${JSON.stringify(other.id)})).appendChild(destination);`})),/parentId/);
 assert.equal(m.nodes.size,before);assert.equal(m.nodes.has(previous.rootId),true);
});
test('explicit position under Auto Layout is ABSOLUTE without changing parent layout',async()=>{
 const m=createFigmaMock(),master=m.make('FRAME',{layoutMode:'HORIZONTAL'},m.page);
 const r=await executeGenerated(m.figma,buildRenderCode({parentId:master.id,position:{x:12,y:34},spec:{key:'x',name:'X',width:20,height:20,children:[]}}));
 const wrapper=m.nodes.get(r.sectionId);assert.equal(wrapper.layoutPositioning,'ABSOLUTE');
 assert.equal(wrapper.x,12);assert.equal(wrapper.y,34);assert.equal(master.layoutMode,'HORIZONTAL');
});
test('independent processes cannot both begin one differently cased UUID',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'uuid-process-race-'));
 try{
 const {spawn}=await import('node:child_process');
 const url=new URL('../src/operation-journal.mjs',import.meta.url).href;
 const script=`import {OperationJournal} from ${JSON.stringify(url)};try{new OperationJournal(process.argv[1]).begin({fileKey:'file',name:'patch_nodes',operationId:process.argv[2],args:{}},'socket');console.log('created');}catch(e){if(e.code!=='OPERATION_ALREADY_EXISTS')throw e;console.log('existing');}`;
 const id='aabbccdd-abcd-4abc-aabc-aabbccddeeff';
 const results=await Promise.all([id,id.toUpperCase()].map(uuid=>new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,['--input-type=module','-e',script,dir,uuid]);let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(Error(err)));
 })));
 assert.deepEqual(results.sort(),['created','existing']);
 const {readdirSync}=await import('node:fs');assert.deepEqual(readdirSync(join(dir,'operations')),[id+'.json']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
