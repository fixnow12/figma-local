import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareInstallation} from '../scripts/prepare-install.mjs';
import {startBroker} from '../src/broker.mjs';
import {BrokerClient} from '../src/broker-client.mjs';
import {OperationJournal} from '../src/operation-journal.mjs';
import {pluginRevision} from '../src/runtime-info.mjs';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'mutation-reconcile-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await prepareInstallation(directory);const broker=await startBroker({directory,port:0});t.after(()=>broker.stop());
 const client=new BrokerClient({directory,ports:[broker.bridge.port],autoStart:false});t.after(()=>client.stop());await client.connect();
 const m=createFigmaMock();m.figma.fileKey='file';m.figma.loadAllPagesAsync=async()=>{};
 const target=m.make('FRAME',{},m.page);target.setPluginData('codex-spec-key','target');
 const a=m.make('COMPONENT',{},target);a.setPluginData('codex-spec-key','a');
 const acknowledgements=[],socket={readyState:1,close(){},terminate(){},send(value){acknowledgements.push(JSON.parse(value));}};
 const fileInfo={fileKey:'file',pluginBuild:pluginRevision()};
 broker.bridge.wsServer.clients.set('file',{ws:socket,fileInfo});broker.bridge.wsServer.socketKeys.set(socket,'file');
 broker.bridge.status=()=>({connected:true,files:[fileInfo]});broker.bridge.waitForConnection=async()=>{};
 let idle={fileKey:'file',responsive:true,busy:false,pendingExecutions:0,activeOperation:null},meta,readbacks=0;
 broker.bridge.executionStatus=async()=>idle;
 broker.bridge.execute=async(code,options)=>{
  if(code==='write'){meta=options.operation.journal;throw Object.assign(Error('lost receipt'),{code:'PLUGIN_EXECUTION_TIMEOUT',operationStatus:'unknown'});}
  if(options.operation?.name==='reconcile_mutation_readback')readbacks++;
  return {result:code==='read'?{}:await executeGenerated(m.figma,code),fileContext:{fileKey:'file'}};
 };
 const input={fileKey:'file',patches:[{key:'target',append:[{key:'a',type:'component',name:'A'},{key:'b',type:'component',name:'B'}]}]};
 await assert.rejects(client.execute('write',{fileKey:'file',operation:{name:'patch_nodes',mutating:true,operationInput:input}}),{operationStatus:'unknown'});
 const args={fileKey:'file',operationId:meta.operationId,argsHash:meta.argsHash};
 return {directory,broker,client,m,socket,fileInfo,args,meta,acknowledgements,get readbacks(){return readbacks;},setIdle(value){idle=value;}};
}
test('readback alone stays blocked; same-runtime idle reconciliation persists unknown and allows only a new request',async t=>{
 const f=await fixture(t);
 await f.client.execute('read',{fileKey:'file',operation:{name:'inspect_selection',mutating:false}});
 await assert.rejects(f.client.execute('blocked',{fileKey:'file',operation:{name:'patch_nodes',mutating:true}}),{code:'OPERATION_IN_PROGRESS'});
 const r=await f.client.reconcileMutation(f.args);
 assert.equal(r.operation.settled,true);assert.equal(r.operation.operationStatus,'unknown');assert.equal(r.operation.recovery.replayAllowed,false);
 assert.equal(r.operation.recovery.originalRecord.settled,false);
 assert.ok(r.operation.recovery.proof.readback.matches.some(n=>n.key==='a'));
 assert.equal(r.operation.recovery.proof.readback.matches.some(n=>n.key==='b'),false);
 assert.equal(JSON.stringify(r).includes('resumeTokenHash'),false);
 const durable=new OperationJournal(f.directory).get('file',f.args.operationId);assert.equal(durable.recovery.kind,'mutation-idle-readback');
 const repeated=await f.client.reconcileMutation(f.args);assert.deepEqual(repeated,r);assert.equal(f.readbacks,1);
 const original={...r.operation.operationInput,operationId:f.args.operationId};
 // Original UUID still cannot be used, regardless of any recovered missing keys.
 await assert.rejects(f.client.execute('replay',{fileKey:'file',operation:{name:'patch_nodes',mutating:true,operationInput:original}}),e=>['OPERATION_ALREADY_EXISTS','OPERATION_ARGUMENTS_MISMATCH'].includes(e.code));
 const late={...f.meta,sequence:1,stage:'settled',success:false,operationStatus:'rolled_back',code:'LATE',error:'late error'};
 f.broker.bridge.wsServer.onOperationEvent(f.socket,late);assert.equal(f.acknowledgements.at(-1).type,'OPERATION_JOURNAL_ACK');
 const saved=(await f.client.operationStatus(f.args)).operation;assert.equal(saved.operationStatus,'unknown');assert.equal(saved.lateReceipt.error,'late error');
});
test('busy, different connection, hash mismatch and incomplete read cannot reconcile',async t=>{
 const f=await fixture(t),idle={fileKey:'file',responsive:true,busy:false,pendingExecutions:0,activeOperation:null};
 await assert.rejects(f.client.reconcileMutation({...f.args,argsHash:'0'.repeat(64)}),{code:'OPERATION_ARGUMENTS_MISMATCH'});
 f.setIdle({...idle,busy:true});await assert.rejects(f.client.reconcileMutation(f.args),{code:'MUTATION_RECONCILIATION_PROOF_REJECTED'});
 f.setIdle(idle);const file=f.broker.bridge.wsServer.clients.get('file');
 f.broker.bridge.wsServer.clients.set('file',{...file,ws:{readyState:1,close(){},terminate(){}}});
 await assert.rejects(f.client.reconcileMutation(f.args),{code:'MUTATION_RECONCILIATION_PROOF_REJECTED'});
 f.broker.bridge.wsServer.clients.set('file',file);
 f.m.figma.loadAllPagesAsync=async()=>{throw Error('incomplete read');};
 await assert.rejects(f.client.reconcileMutation(f.args),/incomplete read/);
 assert.equal((await f.client.operationStatus(f.args)).operation.settled,false);
});
