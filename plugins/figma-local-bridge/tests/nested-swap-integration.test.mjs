import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {prepareInstallation} from '../scripts/prepare-install.mjs';import {startBroker} from '../src/broker.mjs';import {BrokerClient} from '../src/broker-client.mjs';
import {pluginRevision} from '../src/runtime-info.mjs';import {runToolOperation} from '../src/tool-results.mjs';
test('typed wrapper sends exact nested swap arguments to durable journal boundary',async()=>{
 const input={fileKey:'wallet',operationKey:'root/swap',rootId:'1:2',swaps:[]};let operation;
 const bridge={runInFile:async(_key,fn)=>fn({fileKey:'wallet'}),execute:async(_code,options)=>{operation=options.operation;return {result:{rootId:'1:2'}};}};
 await runToolOperation(bridge,input,'return {};',{operationName:'swap_nested_components',mutating:true});assert.deepEqual(operation.operationInput,input);
});
test('broker persists swap before dispatch, settles exact proof, rejects repeat and altered payload',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'nested-broker-'));t.after(()=>rm(directory,{recursive:true,force:true}));await prepareInstallation(directory);
 const broker=await startBroker({directory,port:0});t.after(()=>broker.stop());const client=new BrokerClient({directory,ports:[broker.bridge.port],autoStart:false});t.after(()=>client.stop());await client.connect();
 const socket={readyState:1,terminate(){},close(){},send(){}};const info={fileKey:'wallet',currentPageId:'0:1',pluginBuild:pluginRevision()};broker.bridge.wsServer.clients.set('wallet',{ws:socket,fileInfo:info});broker.bridge.wsServer.socketKeys.set(socket,'wallet');broker.bridge.waitForConnection=async()=>{};broker.bridge.status=()=>({connected:true,files:[info]});
 let calls=0,firstJournal;broker.bridge.execute=async(_code,opts)=>{calls++;firstJournal=opts.operation.journal;assert.ok(firstJournal,'swap dispatch must have durable journal');broker.bridge.wsServer.onOperationEvent(socket,{...firstJournal,sequence:1,stage:'verified',id:'1:2'});broker.bridge.wsServer.onOperationEvent(socket,{...firstJournal,sequence:2,stage:'settled',success:true});return {result:{rootId:'1:2'}};};
 const created=await client.execute('create',{fileKey:'wallet',operation:{name:'use_component',mutating:true,operationInput:{fileKey:'wallet',key:'root',parentKey:'container',sourceId:'source'}}});calls=0;
 const input={operationId:'00000000-0000-4000-8000-000000000002',fileKey:'wallet',operationKey:'root/nested',rootId:'1:2',rootKey:'root',rootParentKey:'container',rootParentId:'1:1',rootSourceId:'source',rootLibraryKey:'a'.repeat(40),creationOperationId:created.operationId},args={fileKey:'wallet',operation:{name:'swap_nested_components',mutating:true,operationInput:input}};
 await client.execute('swap',args);
 assert.ok(firstJournal.operationId);const status=await client.call('operationStatus',{fileKey:'wallet',operationId:firstJournal.operationId});assert.deepEqual(status.operation.operationInput,input);assert.equal(status.operation.settled,true);assert.equal(status.operation.state,'verified');assert.equal(status.operation.operationStatus,'applied');
 await assert.rejects(client.execute('repeat',args),{code:'OPERATION_ALREADY_EXISTS'});assert.equal(calls,1);
 await assert.rejects(client.execute('changed',{...args,operation:{...args.operation,operationInput:{...input,rootId:'changed'}}}),{code:'OPERATION_ARGUMENTS_MISMATCH'});assert.equal(calls,1);
});
