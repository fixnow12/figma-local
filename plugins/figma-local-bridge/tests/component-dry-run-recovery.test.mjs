import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {prepareInstallation} from '../scripts/prepare-install.mjs';
import {startBroker} from '../src/broker.mjs';
import {BrokerClient} from '../src/broker-client.mjs';
import {pluginRevision} from '../src/runtime-info.mjs';
import {OperationJournal} from '../src/operation-journal.mjs';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';

async function fixture(t, options={}) {
 const directory=await mkdtemp(join(tmpdir(),'dry-run-recovery-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await prepareInstallation(directory);
 const broker=await startBroker({directory,port:0});
 t.after(()=>broker.stop());
 const client=new BrokerClient({directory,ports:[broker.bridge.port],autoStart:false});
 t.after(()=>client.stop()); await client.connect();
 const mock=createFigmaMock(); mock.figma.fileKey='wallet';
 mock.figma.loadAllPagesAsync=async()=>{};
 let idle={fileKey:'wallet',responsive:true,busy:false,pendingExecutions:0,activeOperation:null};
 const socket=()=>({readyState:1,terminate(){},close(){},send(){}});
 const old=socket(),fresh=socket(),fileInfo={fileKey:'wallet',currentPageId:mock.page.id,pluginBuild:pluginRevision()};
 broker.bridge.wsServer.clients.set('wallet',{ws:old,fileInfo});
 broker.bridge.wsServer.socketKeys.set(old,'wallet');
 broker.bridge.waitForConnection=async()=>{};
 broker.bridge.status=()=>({connected:true,files:[fileInfo]});
 broker.bridge.executionStatus=async()=>idle;
 let dispatch;
 broker.bridge.execute=async(code,opts)=>{
  if(opts.operation.name==='use_component') {
   dispatch=opts.operation.journal;
   throw Object.assign(Error('timeout'),{code:'PLUGIN_EXECUTION_TIMEOUT',operationStatus:'unknown'});
  }
  const result=await executeGenerated(mock.figma,code);
  return {result,fileContext:{fileKey:'wallet'}};
 };
 const input={fileKey:'wallet',libraryKey:'a'.repeat(40),key:'target/input',dryRun:true,...options.input};
 await assert.rejects(client.execute('native import',{fileKey:'wallet',operation:{name:options.name||'use_component',mutating:!input.dryRun,operationInput:input}}),{code:'PLUGIN_EXECUTION_TIMEOUT'});
 const args={fileKey:'wallet',operationId:dispatch.operationId,argsHash:dispatch.argsHash};
 const before=JSON.parse(await readFile(join(directory,'operations',args.operationId+'.json'),'utf8'));
 function reconnect() {
  old.readyState=3;broker.bridge.wsServer.socketKeys.delete(old);
  broker.bridge.wsServer.clients.set('wallet',{ws:fresh,fileInfo});
  broker.bridge.wsServer.socketKeys.set(fresh,'wallet');
 }
 if(options.reconnect!==false)reconnect();
 return {client,broker,directory,args,before,input,mock,old,fresh,fileInfo,reconnect,dispatch,setIdle:v=>{idle=v;}};
}

test('recover dead dryRun leaves native import unknown, preserves original record, unlocks canvas and bans resource replay',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.client.execute('blocked',{fileKey:'wallet',operation:{name:'patch_nodes',mutating:true}}),{code:'OPERATION_IN_PROGRESS'});
 const result=await f.client.call('recoverComponentDryRun',f.args);
 assert.equal(result.operationStatus,'unknown');
 assert.equal(result.operation.settled,true);
 assert.equal(result.operation.state,'unknown');
 assert.equal(result.operation.operationStatus,'unknown');
 assert.equal(result.operation.recovery.canvasMutationExcluded,true);
 assert.equal(result.operation.recovery.nativeImportOutcome,'unknown');
 assert.equal(result.operation.recovery.replayAllowed,false);
 const durable=JSON.parse(await readFile(join(f.directory,'operations',f.args.operationId+'.json'),'utf8'));
 assert.deepEqual(durable.recovery.originalRecord,f.before);
 assert.equal(JSON.stringify(result).includes('resumeTokenHash'),false);
 assert.equal(f.mock.writes.length,0);
 const next=await f.client.execute('return {ok:true};',{fileKey:'wallet',operation:{name:'patch_nodes',mutating:true}});
 assert.equal(next.result.ok,true);
 // Changing the stable canvas key must not bypass the unresolved native import.
 await assert.rejects(f.client.execute('replay',{fileKey:'wallet',operation:{name:'use_component',mutating:false,operationInput:{...f.input,key:'another/input'}}}),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 const reloaded=new OperationJournal(f.directory);
 assert.throws(()=>reloaded.begin({fileKey:'wallet',name:'use_component',args:{...f.input,key:'new/key',dryRun:false}},'another'),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
});

for(const [name,change,options] of [
 ['same connection',f=>f.broker.bridge.wsServer.clients.set('wallet',{ws:f.old,fileInfo:f.fileInfo})],
 ['old socket still live',f=>{f.old.readyState=1;f.broker.bridge.wsServer.socketKeys.set(f.old,'wallet');}],
 ['active operation',f=>f.setIdle({fileKey:'wallet',responsive:true,busy:false,pendingExecutions:0,activeOperation:{name:'other'}})],
 ['busy after readback',f=>{f.mock.figma.loadAllPagesAsync=async()=>f.setIdle({fileKey:'wallet',responsive:true,busy:true,pendingExecutions:0,activeOperation:null});}],
 ['busy plugin',f=>f.setIdle({fileKey:'wallet',responsive:true,busy:true,pendingExecutions:0,activeOperation:null})],
 ['pending execution',f=>f.setIdle({fileKey:'wallet',responsive:true,busy:false,pendingExecutions:1,activeOperation:null})],
 ['incomplete readiness',f=>f.setIdle({fileKey:'wallet',responsive:true,busy:false,activeOperation:null})],
 ['unresponsive plugin',f=>f.setIdle({fileKey:'wallet',responsive:false})],
 ['outdated plugin',f=>{f.fileInfo.pluginBuild='old';}],
 ['wrong hash',f=>{f.args.argsHash='b'.repeat(64);}],
 ['wrong target',f=>{f.args.fileKey='foreign';}],
 ['existing key on another page',f=>{
  const page=f.mock.make('PAGE',{},null);f.mock.figma.root.children.push(page);
  f.mock.key(f.mock.make('FRAME',{},page),f.input.key);
 }],
 ['incomplete page read',f=>{f.mock.figma.loadAllPagesAsync=async()=>{throw Error('read failed');};}],
 ['dryRun false',()=>{}, {input:{dryRun:false}}],
 ['progress already recorded',f=>{
  f.broker.bridge.wsServer.onOperationEvent(f.fresh,{...f.dispatch,sequence:1,stage:'component-import',id:'native-id'});
 }],
 ['caller proof injection',f=>{f.args.readback={absent:true};}],
 ['connection changes during readback',f=>{
  f.mock.figma.loadAllPagesAsync=async()=>{
   f.broker.bridge.wsServer.clients.set('wallet',{ws:f.old,fileInfo:f.fileInfo});
  };
 }],
])test('recovery rejects '+name+' without changing journal',async t=>{
 const f=await fixture(t,options);await change(f);
 const path=join(f.directory,'operations',f.before.operationId+'.json');
 const before=await readFile(path,'utf8');
 await assert.rejects(f.client.call('recoverComponentDryRun',f.args));
 assert.equal(await readFile(path,'utf8'),before);
 assert.equal(new OperationJournal(f.directory).get('wallet',f.before.operationId).settled,false);
});

test('journal refuses recovery for ordinary writes and unverified claims',()=>{
 const input={fileKey:'wallet',name:'patch_nodes',args:{fileKey:'wallet',libraryKey:'component',key:'target',dryRun:true}};
 const journal=new OperationJournal(mkdtempSync(join(tmpdir(),'recovery-scope-')));
 const r=journal.begin(input,'old');
 journal.mark(r.operationId,{state:'unknown',operationStatus:'unknown',commandSent:true});
 assert.throws(()=>journal.getRecoverableComponentDryRun({fileKey:'wallet',operationId:r.operationId,argsHash:r.argsHash}),{code:'DRY_RUN_RECOVERY_SCOPE_REJECTED'});
});

test('journal cannot settle a dryRun from incomplete or caller-claimed proof',()=>{
 const j=new OperationJournal(mkdtempSync(join(tmpdir(),'recovery-proof-')));
 const r=j.begin({fileKey:'wallet',name:'use_component',args:{fileKey:'wallet',libraryKey:'component',key:'target',dryRun:true}},'old');
 j.mark(r.operationId,{state:'unknown',operationStatus:'unknown',commandSent:true});
 assert.throws(()=>j.recoverComponentDryRun({fileKey:'wallet',operationId:r.operationId,argsHash:r.argsHash},{oldConnectionAbsent:true,currentConnectionId:'new',readback:{absent:true}}),{code:'DRY_RUN_RECOVERY_PROOF_REJECTED'});
 assert.equal(j.get('wallet',r.operationId).settled,false);
});

test('assembly apply cannot replay a recovered component library key',async t=>{
 const f=await fixture(t);await f.client.call('recoverComponentDryRun',f.args);
 let imports=0;f.mock.figma.importComponentByKeyAsync=async()=>{imports++;return {};};
 await assert.rejects(f.client.execute('await figma.importComponentByKeyAsync("'+f.input.libraryKey+'"); return {};',{
  fileKey:'wallet',operation:{name:'assemble_library_template',mutating:true,componentImportKeys:[f.input.libraryKey]}}),
  {code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 assert.equal(imports,0);
 // Missing import metadata must fail closed on affected files.
 await assert.rejects(f.client.execute('return {};',{fileKey:'wallet',operation:{name:'assemble_library_template',mutating:true}}),
  {code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 const verify=await f.client.execute('return {verified:true};',{fileKey:'wallet',operation:{name:'assemble_library_template',mutating:false,componentImportKeys:[]}});
 assert.equal(verify.result.verified,true);
});

test('typed operation wrapper passes assembly keys to the broker replay guard',async t=>{
 const {runToolOperation}=await import('../src/tool-results.mjs');
 const f=await fixture(t);await f.client.recoverComponentDryRun(f.args);
 let imports=0;f.mock.figma.importComponentByKeyAsync=async()=>{imports++;return {};};
 const result=await runToolOperation(f.client,{fileKey:'wallet',mode:'apply',snapshot:{nodes:[{libraryKey:f.input.libraryKey}]}},
  'await figma.importComponentByKeyAsync("'+f.input.libraryKey+'");return {};',{operationName:'assemble_library_template',mutating:true});
 assert.equal(result.isError,true);
 assert.equal(result.structuredContent.code,'NATIVE_IMPORT_REPLAY_FORBIDDEN');
 assert.equal(imports,0);
});

test('recovered unknown set import blocks another child and assembly after durable restart',async t=>{
 const setKey='b'.repeat(40),otherChild='c'.repeat(40);
 const f=await fixture(t,{input:{librarySetKey:setKey,variant:{State:'Default'}}});
 const recovered=await f.client.recoverComponentDryRun(f.args);
 assert.equal(recovered.operation.recovery.nativeImportOutcome,'unknown');
 const journal=new OperationJournal(f.directory);
 const input={fileKey:'wallet',name:'use_component',args:{...f.input,libraryKey:otherChild}};
 assert.throws(()=>journal.assertNativeImportReplayAllowed(input),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 const direct={...input,args:{...input.args}};delete direct.args.librarySetKey;
 assert.throws(()=>journal.assertNativeImportReplayAllowed(direct),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({...input,args:{...input.args,librarySetKey:'d'.repeat(40)}}));
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({...direct,fileKey:'other',args:{...direct.args,fileKey:'other'}}));
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({...input,args:{fileKey:'wallet',sourceId:'local-component',key:'new-local',dryRun:true}}));
 await assert.rejects(f.client.execute('native direct import',{fileKey:'wallet',operation:{name:'use_component',mutating:false,operationInput:direct.args}}),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 // Assembly only declares child import keys. It cannot prove whether a new key
 // belongs to the unknown imported set, so nonempty imports must fail closed.
 for(const keys of [[f.input.libraryKey],[setKey],[otherChild]]){
  assert.throws(()=>journal.assertNativeImportReplayAllowed({fileKey:'wallet',name:'assemble_library_template',mutating:true,componentImportKeys:keys}),{code:'NATIVE_IMPORT_REPLAY_FORBIDDEN'});
 }
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({fileKey:'other',name:'assemble_library_template',mutating:true,componentImportKeys:[otherChild]}));
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({fileKey:'wallet',name:'assemble_library_template',mutating:true,componentImportKeys:[]}));
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed({fileKey:'wallet',name:'assemble_library_template',mutating:false}));
 let imports=0;f.mock.figma.importComponentByKeyAsync=async()=>{imports++;return {};};
 const {runToolOperation}=await import('../src/tool-results.mjs');
 const result=await runToolOperation(f.client,{fileKey:'wallet',mode:'apply',snapshot:{nodes:[{libraryKey:otherChild}]}},
  'await figma.importComponentByKeyAsync("'+otherChild+'");return {};',{operationName:'assemble_library_template',mutating:true});
 assert.equal(result.structuredContent.code,'NATIVE_IMPORT_REPLAY_FORBIDDEN');assert.equal(imports,0);
});

test('assembly imports remain available without a recovered unknown set',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'assembly-set-boundary-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const journal=new OperationJournal(directory),args={fileKey:'wallet',librarySetKey:'b'.repeat(40),libraryKey:'a'.repeat(40),key:'target/component',dryRun:true};
 const assembly={fileKey:'wallet',name:'assemble_library_template',mutating:true,componentImportKeys:['c'.repeat(40)]};
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed(assembly));
 const direct={fileKey:'wallet',name:'use_component',args:{fileKey:'wallet',libraryKey:'c'.repeat(40),key:'direct',dryRun:true}};
 assert.doesNotThrow(()=>journal.assertNativeImportReplayAllowed(direct));
 const record=journal.begin({fileKey:'wallet',name:'use_component',args},'test-connection');
 journal.mark(record.operationId,{settled:true,state:'verified',operationStatus:'applied',stage:'verified',resourceId:'component-id'});
 assert.doesNotThrow(()=>new OperationJournal(directory).assertNativeImportReplayAllowed(assembly));
 assert.doesNotThrow(()=>new OperationJournal(directory).assertNativeImportReplayAllowed(direct));
});
