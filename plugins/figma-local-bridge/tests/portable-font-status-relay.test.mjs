import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {FigmaBridge} from '../src/bridge.mjs';
import {runtimeDiagnostics,sourceRevision,brokerRevision,pluginRevision} from '../src/runtime-info.mjs';

test('pending native font state survives plugin UI and Bridge relay without claiming command busy',async()=>{
 const source=readFileSync(new URL('../src/figma-plugin/ui.html',import.meta.url),'utf8');
 const start=source.indexOf('const handleResult = (resultType, dataKey) => {');
 const end=source.indexOf('// Handle message types',start);assert.ok(start>0&&end>start);
 const fontService={pendingCount:1,pending:[{requestId:1,kind:'load',family:'Factor IO',style:'Bold',timedOut:true}],recent:[]};
 const msg={type:'GET_EXECUTION_STATUS_RESULT',requestId:'status',success:true,busy:false,pendingExecutions:0,activeOperation:null,fontService};
 let relayed;const pending=new Map([['status',{resolve:reply=>{relayed=reply;}}]]);
 vm.runInNewContext(source.slice(start,end)+"handleResult('GET_EXECUTION_STATUS');",{msg,window:{__figmaPendingRequests:pending},clearTimeout});
 assert.equal(pending.size,0);assert.equal(relayed.fontService,fontService);
 // Call the real read method with a local transport double; no port/server/client starts.
 const status=await FigmaBridge.prototype.executionStatus.call({wsServer:{sendCommand:async(method,args,timeout,fileKey)=>{assert.equal(method,'GET_EXECUTION_STATUS');assert.equal(fileKey,'target');return relayed;}}},'target');
 assert.equal(status.fontService,fontService);assert.equal(status.responsive,true);assert.equal(status.busy,false);
 const diagnostics=runtimeDiagnostics({connected:true,files:[{fileKey:'target',pluginBuild:pluginRevision()}],runtime:{revision:sourceRevision(),brokerRevision:brokerRevision()},execution:[status]},{fileKey:'target'});
 assert.equal(diagnostics.state,'READY','command availability is deliberately separate from native font availability');
});
