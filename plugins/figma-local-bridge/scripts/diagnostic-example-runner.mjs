// Injectable proposal runner, not a CLI: importing does not open Bridge or touch files.
// The coordinator supplies an already guarded typed client and private durable writer.
import assert from 'node:assert/strict';
import {readLocalDiagnosticScope} from '../src/catalog-diagnostic-scope.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {verifyDiagnosticProof} from './diagnostic-example-proof.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function collectDiagnosticRoot({rootId,call,save,shouldStop=()=>false}){
  const scope=readLocalDiagnosticScope('diagnosticExample');
  assert.ok(scope.nodeIds.includes(rootId));assert.equal(typeof call,'function');assert.equal(typeof save,'function');
  const {fileKey,pageId}=scope;
  const traversalId='diag-chat-'+randomUUID();
  const prefix=rootId.replace(':','-'),archives=[];
  const persist=async(name,bytes)=>{const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);await save(name,data);const sha256=hash(data);await save(name+'.sha256',Buffer.from(sha256+'\n'));archives.push({name,sha256,bytes:data.length});};
  async function phase(name,extra={},stopAtPng=false){
    let cursor,png,sequence=0;const rows=[],seen=new Set();
    do{
      assert.ok(!shouldStop(),'Diagnostic reader stopped by resource/status guard');assert.ok(++sequence<=10000,'Diagnostic continuation limit');
      const args={fileKey,pageId,nodeId:rootId,traversalId,limit:20,...extra,...(cursor?{cursor}:{})};
      const key=JSON.stringify(args);assert.ok(!seen.has(key),'Repeated source request forbidden');seen.add(key);
      const request={at:new Date().toISOString(),tool:'read_diagnostic_example',arguments:args};
      const stem=prefix+'-'+name+'-'+String(sequence).padStart(4,'0');await persist(stem+'-request.json',JSON.stringify(request));
      let response;
      try{response=await call('read_diagnostic_example',args);}catch(error){await persist(stem+'-transport-error.json',JSON.stringify({message:String(error.message),unknownOutcome:true}));throw error;}
      await persist(stem+'-response.json',JSON.stringify(response));
      assert.notEqual(response?.isError,true,'Diagnostic source error; no retry');
      const content=response.structuredContent;assert.equal(content?.operationStatus,'read');assert.equal(content.fileContext?.fileKey,fileKey);
      const row=content.result;assert.equal(row?.kind,'diagnostic-tree');assert.equal(row.catalogEligible,false);assert.equal(row.rootNodeId,rootId);assert.equal(row.pageId,pageId);assert.equal(row.fileKey,fileKey);
      rows.push(row);cursor=row.nextCursor;
      if(stopAtPng&&row.screenshotNodeId){
        assert.equal(row.screenshotNodeId,rootId);assert.equal(row.traversal?.verified,true);assert.equal(content.screenshot?.status,'captured','PNG not captured');
        const images=response.content.filter(x=>x.type==='image');assert.equal(images.length,1);assert.equal(images[0].mimeType,'image/png');
        png=Buffer.from(images[0].data,'base64');await persist(prefix+'.png',png);break;
      }
    }while(cursor);
    if(stopAtPng)assert.ok(png,'Missing PNG');return {rows,png};
  }
  const capture=await phase('capture');
  const before=await phase('png',{verificationId:'diag-check-'+randomUUID(),requireExistingSnapshot:true,includePng:true,screenshotScale:1},true);
  const after=await phase('final',{verificationId:'diag-check-'+randomUUID(),requireExistingSnapshot:true});
  const proof=verifyDiagnosticProof({scope,rootId,capture:capture.rows,pngVerification:before.rows,finalVerification:after.rows,png:before.png});
  await persist(prefix+'-proof.json',JSON.stringify({...proof,archives},null,2));return proof;
}
