// Offline validator only: no IO, RPC or catalog eligibility promotion.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const fields=['componentPropertyDefinitions','variantGroupProperties','variantProperties'];
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const encode=value=>JSON.stringify(canonical(value));
const digest=value=>createHash('sha256').update(value).digest('hex');
export function verifyDiagnosticProof({scope,rootId,capture,pngVerification,finalVerification,png}){
  assert.ok(scope && typeof scope.fileKey==='string' && typeof scope.pageId==='string' && typeof scope.parentNodeId==='string');
  assert.ok(Array.isArray(scope.nodeIds) && scope.nodeIds.includes(rootId));
  let identity;
  function inspect(rows,{whole=false,verified=false}={}){
    assert.ok(Array.isArray(rows)&&rows.length>0);const nodes=[],gaps=[];let offset=0,verificationId;
    for(const row of rows){
      assert.equal(row.kind,'diagnostic-tree');assert.equal(row.projection,'chat-known-source-errors-v1');
      assert.equal(row.catalogEligible,false);assert.equal(row.catalogFull,false);assert.equal(row.complete,undefined);
      assert.equal(row.fileKey,scope.fileKey);assert.equal(row.pageId,scope.pageId);assert.equal(row.rootNodeId,rootId);
      assert.equal(row.propertyCoverage?.complete,false);
      const t=row.traversal;assert.ok(t&&typeof t.id==='string'&&typeof t.sessionId==='string'&&Number.isInteger(t.generation));
      const same=[t.id,t.sessionId,t.generation];if(!identity)identity=same;assert.deepEqual(same,identity);
      assert.ok(Array.isArray(row.nodes)&&Array.isArray(row.gaps));
      if(row.total===null){assert.equal(row.nodes.length,0);continue;}
      assert.equal(row.offset,offset);offset+=row.nodes.length;assert.ok(offset<=row.total);
      assert.equal(t.complete,true);assert.equal(t.visitedNodes,row.total);
      if(verified){assert.equal(t.verified,true);assert.equal(t.verifiedNodes,row.total);assert.ok(t.verificationId?.startsWith('diag-check-'));verificationId??=t.verificationId;assert.equal(t.verificationId,verificationId);}
      for(const node of row.nodes)for(const field of fields)assert.ok(!Object.hasOwn(node.properties,field),'Excluded property was returned');
      nodes.push(...row.nodes);gaps.push(...row.gaps);
    }
    const last=rows.at(-1);assert.ok(nodes.length>0);
    if(whole){assert.equal(last.treeComplete,true);assert.equal(last.nextCursor,null);assert.equal(last.unreadNodeCount,0);assert.deepEqual(last.unreadNodeIds,[]);assert.equal(last.unreadNodeIdsComplete,true);assert.equal(nodes.length,last.total);}
    return {nodes,gaps,verificationId,total:last.total};
  }
  const a=inspect(capture,{whole:true}),b=inspect(pngVerification,{verified:true}),c=inspect(finalVerification,{whole:true,verified:true});
  assert.notEqual(b.verificationId,c.verificationId,'Post-PNG verification must be fresh');
  assert.equal(a.total,b.total);assert.equal(a.total,c.total);
  assert.equal(encode(a),encode({...c,verificationId:undefined}),'Projected tree changed after capture');
  assert.equal(encode(b.nodes),encode(a.nodes.slice(0,b.nodes.length)),'Pre-PNG projection differs');
  const map=new Map(a.nodes.map(n=>[n.id,n]));assert.equal(map.size,a.nodes.length);
  const root=map.get(rootId);assert.equal(a.nodes[0].id,rootId);assert.equal(root.type,'COMPONENT');assert.equal(root.parentId,scope.parentNodeId);
  const seen=new Set(),pending=[root];
  while(pending.length){const node=pending.pop();assert.ok(!seen.has(node.id),'Cycle or duplicate child');seen.add(node.id);assert.ok(Array.isArray(node.childIds));
    for(const id of node.childIds){const child=map.get(id);assert.ok(child,'Missing descendant');assert.equal(child.parentId,node.id);pending.push(child);}}
  assert.equal(seen.size,map.size,'Disconnected tree');
  for(const gap of a.gaps.filter(g=>fields.includes(g.field))){assert.equal(gap.reason,'skipped-known-source-error');assert.equal(gap.absenceConfirmed,false);}
  assert.ok(Buffer.isBuffer(png)&&png.length>=45);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.subarray(12,16).toString(),'IHDR');assert.ok(png.readUInt32BE(16)>0&&png.readUInt32BE(20)>0);assert.equal(png.subarray(-8,-4).toString(),'IEND');
  return {kind:'diagnostic-proof',rootId,treeComplete:true,catalogEligible:false,catalogFull:false,propertyCoverageComplete:false,
    nodeCount:a.nodes.length,treeSHA256:digest(encode({nodes:a.nodes,gaps:a.gaps})),pngSHA256:digest(png),pngBytes:png.length,
    traversalId:identity[0],sessionId:identity[1],generation:identity[2],beforePngVerificationId:b.verificationId,afterPngVerificationId:c.verificationId,gaps:a.gaps};
}
