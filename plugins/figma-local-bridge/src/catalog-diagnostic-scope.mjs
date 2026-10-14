import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
const fileKey=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const nodeId=z.string().max(128).regex(/^\d+:\d+$/);
export const diagnosticScopeConfigSchema=z.object({
  version:z.literal(1),
  prewarm:z.object({fileKey,pageId:nodeId}).strict().optional(),
  diagnosticExample:z.object({fileKey,pageId:nodeId,parentNodeId:nodeId,
    nodeIds:z.array(nodeId).min(1).max(16).refine(ids=>new Set(ids).size===ids.length,'Duplicate roots')}).strict().optional(),
}).strict().refine(value=>value.prewarm||value.diagnosticExample,'At least one bounded scope is required');

/** Host-owned scope only. Tool arguments cannot select a configuration file. */
export function readLocalDiagnosticScope(operation){
  if(!['prewarm','diagnosticExample'].includes(operation))throw new Error('Unknown diagnostic operation');
  const path=process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE??fileURLToPath(new URL('../diagnostic-scopes.local.json',import.meta.url));
  if(!isAbsolute(path))throw new Error('Diagnostic scope configuration path must be absolute');
  let config;
  try{
    const bytes=readFileSync(path);
    if(bytes.length>65536)throw new Error('Too large');
    config=diagnosticScopeConfigSchema.parse(JSON.parse(bytes.toString('utf8')));
  }catch{
    throw new Error('Diagnostic scope configuration is missing or invalid');
  }
  const scope=config[operation];
  if(!scope)throw new Error('Diagnostic operation has no configured scope');
  return scope;
}
export function validateLocalDiagnosticScope(operation,input,ctx){
  let scope;
  try{scope=readLocalDiagnosticScope(operation);}catch(error){ctx.addIssue({code:'custom',message:error.message});return;}
  if(input.fileKey!==scope.fileKey||input.pageId!==scope.pageId||
      operation==='diagnosticExample'&&!scope.nodeIds.includes(input.nodeId)){
    ctx.addIssue({code:'custom',message:'Request is outside the configured diagnostic scope'});
  }
}
