import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDiagnosticRoot} from '../scripts/diagnostic-example-runner.mjs';
import {verifyDiagnosticProof} from '../scripts/diagnostic-example-proof.mjs';
import {syntheticDiagnosticScope,installSyntheticDiagnosticScope} from './helpers/diagnostic-scope-fixture.mjs';
installSyntheticDiagnosticScope();
const scope=syntheticDiagnosticScope.diagnosticExample;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
function row(args){return {
  kind:'diagnostic-tree',projection:'chat-known-source-errors-v1',catalogEligible:false,catalogFull:false,
  fileKey:scope.fileKey,pageId:scope.pageId,rootNodeId:args.nodeId,propertyCoverage:{complete:false},
  traversal:{id:args.traversalId,sessionId:'synthetic-session',generation:0,complete:true,visitedNodes:1,
    ...(args.verificationId?{verified:true,verifiedNodes:1,verificationId:args.verificationId}:{})},
  nodes:[{id:args.nodeId,type:'COMPONENT',parentId:scope.parentNodeId,childIds:[],properties:{}}],gaps:[],
  offset:0,total:1,treeComplete:true,nextCursor:null,unreadNodeCount:0,unreadNodeIds:[],unreadNodeIdsComplete:true,
  screenshotNodeId:args.includePng?args.nodeId:null,
};}
test('injectable runner binds every request and proof to the configured scope',async()=>{
  const calls=[],saved=new Map();
  const proof=await collectDiagnosticRoot({rootId:scope.nodeIds[0],save:async(name,bytes)=>saved.set(name,bytes),
    call:async(tool,args)=>{
      assert.equal(tool,'read_diagnostic_example');assert.equal(args.fileKey,scope.fileKey);assert.equal(args.pageId,scope.pageId);
      calls.push(args);return {structuredContent:{operationStatus:'read',fileContext:{fileKey:scope.fileKey},result:row(args),
        ...(args.includePng?{screenshot:{status:'captured'}}:{})},
        content:args.includePng?[{type:'image',mimeType:'image/png',data:png.toString('base64')}]:[]};
    }});
  assert.equal(calls.length,3);assert.equal(proof.catalogEligible,false);assert.equal(proof.catalogFull,false);
  assert.notEqual(calls[1].verificationId,calls[2].verificationId);assert.ok(saved.has('200-2-proof.json'));
});
test('runner rejects a foreign root before transport or persistence',async()=>{
  let calls=0;
  await assert.rejects(collectDiagnosticRoot({rootId:'200:999',call:async()=>calls++,save:async()=>calls++}));
  assert.equal(calls,0);
});
test('offline proof rejects a foreign file, parent and scope without upgrading eligibility',()=>{
  const args={nodeId:scope.nodeIds[0],traversalId:'diag-chat-test'};
  const input={scope,rootId:args.nodeId,capture:[row(args)],pngVerification:[row({...args,verificationId:'diag-check-before'})],
    finalVerification:[row({...args,verificationId:'diag-check-after'})],png};
  assert.equal(verifyDiagnosticProof(input).catalogEligible,false);
  for(const field of ['fileKey','pageId','parentNodeId']){
    assert.throws(()=>verifyDiagnosticProof({...input,scope:{...scope,[field]:'999:9'}}));
  }
  assert.throws(()=>verifyDiagnosticProof({...input,scope:{...scope,nodeIds:['999:9']}}));
});
