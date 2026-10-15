// New evidence only: no chmod, ACL changes, cleanup or deletion of user data.
import {mkdir,lstat,open,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assertPrivate} from './installation.mjs';

async function syncDirectory(path) {
 if(process.platform==='win32')return;
 const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}
}
async function makeDirectories(path) {
 try {await mkdir(path,{mode:0o700});await syncDirectory(dirname(path));}
 catch(error){
  if(error.code==='ENOENT'){await makeDirectories(dirname(path));return makeDirectories(path);}
  if(error.code!=='EEXIST')throw error;
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('Evidence path must be a directory, not a symlink');
 }
}
export async function writeEvidence(path,value) {
 const file=await open(path,'wx',0o600);
 try {await file.writeFile(value);await file.sync();}finally{await file.close();}
 await syncDirectory(dirname(path));
}
export function compactReceipt(payload={}) {
 const text=value=>typeof value==='string'?value.slice(0,2048):undefined;
 return {compact:true,fullPayloadStored:false,
  operationId:text(payload.operationId??payload.operation?.operationId),
  argsHash:text(payload.argsHash??payload.operation?.argsHash),operationStatus:text(payload.operationStatus),fileKey:text(payload.fileContext?.fileKey),
  code:text(payload.code),error:text(typeof payload.error==='string'?payload.error:payload.error?.message),
  result:{rootId:text(payload.result?.rootId),sectionId:text(payload.result?.sectionId),key:text(payload.result?.key)},
  nextStep:'Read get_operation_status by fileKey/operationId and inspect affected nodes; this receipt is not the full payload.'};
}
export async function claimEvidence({output,tool,args,inputPath,automaticRoot}) {
 const automatic=!output;
 const root=resolve(automaticRoot||process.env.FIGMA_LOCAL_EVIDENCE_DIR||join(homedir(),'.figma-local-evidence-v1'));
 if(automatic){await makeDirectories(root);await assertPrivate(root,true);}
 const directory=automatic?join(root,randomUUID()):resolve(output);
 await makeDirectories(directory);await assertPrivate(directory,true);
 // Always exclusive, including read calls. Claim before any MCP startup/dispatch.
 if((await readdir(directory)).some(name=>/^(request|response|result|transport)\.json$|^preview-\d+\.png$/.test(name)))throw Object.assign(Error('EEXIST: evidence directory is already in use; choose a fresh output or --read-response'),{code:'EEXIST'});
 const request=automatic?{
  compact:true,tool:String(tool).slice(0,2048),operationId:typeof args.operationId==='string'?args.operationId.slice(0,2048):undefined,fileKey:typeof args.fileKey==='string'?args.fileKey.slice(0,2048):undefined,
  requestHash:createHash('sha256').update(JSON.stringify(args)).digest('hex'),
  inputPath:inputPath?resolve(inputPath):undefined,fullPayloadStored:false,
 }: {tool,args};
 await writeEvidence(join(directory,'request.json'),JSON.stringify(request,null,2));
 return {directory,automatic};
}
