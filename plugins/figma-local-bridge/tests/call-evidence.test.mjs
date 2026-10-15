import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimEvidence,writeEvidence,compactReceipt} from '../src/call-evidence.mjs';

test('automatic evidence is compact, private and retains UUID without payload/PNG',async()=>{
 const root=await mkdtemp(join(tmpdir(),'compact-evidence-'));
 try{
 const args={operationId:'aabbccdd-abcd-4abc-aabc-aabbccddeeff',fileKey:'file',spec:{content:'SENSITIVE_PAYLOAD'.repeat(100000)}};
 const e=await claimEvidence({tool:'render_screen',args,automaticRoot:join(root,'new-state')});
 const saved=await readFile(join(e.directory,'request.json'),'utf8');
 assert.ok(saved.length<2048);assert.doesNotMatch(saved,/SENSITIVE_PAYLOAD/);assert.match(saved,/aabbccdd/);
 const receipt=compactReceipt({operationId:args.operationId,operationStatus:'applied',result:{rootId:'1:2',big:args.spec}});
 await writeEvidence(join(e.directory,'response.json'),JSON.stringify(receipt));
 assert.ok((await stat(join(e.directory,'response.json'))).size<2048);
 assert.deepEqual((await readdir(e.directory)).sort(),['request.json','response.json']);
 if(process.platform!=='win32'){
  assert.equal((await stat(e.directory)).mode&0o777,0o700);
  assert.equal((await stat(join(root,'new-state'))).mode&0o777,0o700);
  assert.equal((await stat(join(e.directory,'request.json'))).mode&0o777,0o600);
  assert.equal((await stat(join(e.directory,'response.json'))).mode&0o777,0o600);
 }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('every new call exclusively claims evidence, including concurrent reads; no overwrites',async()=>{
 const root=await mkdtemp(join(tmpdir(),'exclusive-evidence-'));
 try{
 const output=join(root,'out'),options={output,tool:'render_screen',args:{operationId:'saved'}};
 await claimEvidence(options);const before=await readFile(join(output,'request.json'),'utf8');
 await assert.rejects(claimEvidence({...options,tool:'inspect_selection',args:{}}),{code:'EEXIST'});
 assert.equal(await readFile(join(output,'request.json'),'utf8'),before);
 const races=await Promise.allSettled([1,2].map(()=>claimEvidence({output:join(root,'racing'),tool:'inspect_selection',args:{}})));
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(races.filter(r=>r.status==='rejected').length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('existing permissive directories are rejected without permission changes or deletion',async()=>{
 if(process.platform==='win32')return;
 const root=await mkdtemp(join(tmpdir(),'existing-evidence-'));
 try{
 await writeFile(join(root,'user-data'),'keep');await chmod(root,0o755);
 await assert.rejects(claimEvidence({output:root,tool:'fixture',args:{}}),/права/);
 assert.equal((await stat(root)).mode&0o777,0o755);assert.equal(await readFile(join(root,'user-data'),'utf8'),'keep');
 }finally{await rm(root,{recursive:true,force:true});}
});
