// Offline proposal only. Never dispatches a write or concludes visual fidelity.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {operationArgsHash} from './operation-journal.mjs';
import {patchNodesSchema} from './schemas.mjs';

export function planPatchRecovery({operation, readback}) {
 const r=operation?.operation ?? operation;
 assert.equal(r?.name,'patch_nodes','Only patch_nodes append recovery is supported');
 assert.equal(r.settled,true,'Operation must settle before planning continuation');
 assert.ok(['applied','partial','unknown','rolled_back','not_applied'].includes(r.operationStatus),'Missing terminal outcome');
 assert.equal(r.argsHash,operationArgsHash({fileKey:r.fileKey,name:r.name,args:r.operationInput}),'Operation arguments hash mismatch');
 const input=patchNodesSchema.parse(r.operationInput);
 assert.equal(input.fileKey,r.fileKey,'Operation target mismatch');
 assert.ok(!readback?.isError,'Read-back failed');
 const p=readback.structuredContent ?? readback;
 assert.equal(p.operationStatus,'read','Expected successful read-back');
 assert.equal(p.fileContext?.fileKey,r.fileKey,'Read-back file mismatch');
 assert.equal(p.result?.coverage?.complete,true,'Incomplete read-back');
 assert.deepEqual(p.result.coverage.unread,[],'Unread branches remain');
 assert.ok(!p.result.truncated && !p.result.missing?.length,'Missing nodes in read-back');
 const keys=new Map(),ids=new Map();
 function visit(n,parent){
  assert.ok(n.id && !ids.has(n.id),'Duplicate or missing node ID');
  assert.ok(n.childCount===undefined || n.childCount===(n.children?.length??0),'Incomplete children');
  if(parent) assert.equal(n.parentId,parent.id,'Inconsistent read-back ancestry');
  ids.set(n.id,n);
  if(n.key){assert.ok(!keys.has(n.key),'Ambiguous key: '+n.key);keys.set(n.key,n);}
  for(const child of n.children??[])visit(child,n);
 }
 for(const root of p.result.selection??[])visit(root);
 const patches=[],existingKeys=[];
 for(const patch of input.patches){
  // Replaying arbitrary setters or rescale from a stale snapshot is unsafe.
  assert.ok(!patch.set,'Address text/marker edits separately with patch_nodes.set after inspection');
  const target=patch.id?ids.get(patch.id):keys.get(patch.key);
  assert.ok(target,'Read the complete append target');
  const original=new Map(patch.append.map(n=>[n.key,n]));
  const groups=new Map();
  for(const n of patch.append){
   const parent=n.parentKey?keys.get(n.parentKey):target;
   const found=keys.get(n.key);
   if(found){
    assert.ok(parent,'Existing child has missing parent: '+n.key);
    assert.equal(found.parentId,parent.id,'Existing key in wrong parent: '+n.key);
    const expectedType={frame:'FRAME',component:'COMPONENT',componentSet:'COMPONENT_SET',text:'TEXT',rectangle:'RECTANGLE',ellipse:'ELLIPSE',line:'LINE',vector:'VECTOR',polygon:'POLYGON',star:'STAR',booleanOperation:'BOOLEAN_OPERATION'}[n.type];
    assert.ok(expectedType,'Imported SVG/image recovery needs explicit inspection');
    assert.equal(found.type,expectedType,'Existing key has wrong type: '+n.key);
    existingKeys.push(n.key);continue;
   }
   // A missing node under an existing parent starts a separate append patch.
   let root=n;
   while(root.parentKey && !keys.has(root.parentKey)) root=original.get(root.parentKey);
   const destination=root.parentKey?keys.get(root.parentKey):target;
   assert.ok(destination,'Missing destination');
   if(!groups.has(destination.id))groups.set(destination.id,[]);
   const copy=structuredClone(n);
   if(n===root)delete copy.parentKey;
   groups.get(destination.id).push(copy);
  }
  for(const [id,append] of groups)patches.push({id,append});
 }
 const next=patches.length?patchNodesSchema.parse({fileKey:r.fileKey,operationId:randomUUID(),patches}):null;
 return {sourceOperationId:r.operationId,sourceArgsHash:r.argsHash,existingKeys,
  next,requiresFreshReadback:true,visual:'not-tested',note:'Proposal only; re-read changed targets before dispatch. Existing keys are preserved, not certified equal to the design.'};
}
