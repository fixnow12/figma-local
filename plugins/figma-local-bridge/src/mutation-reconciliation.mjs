import {z} from 'zod';
export const reconcileMutationInputSchema={fileKey:z.string().min(1).max(160),operationId:z.string().uuid(),argsHash:z.string().regex(/^[a-f0-9]{64}$/)};
export const reconcileMutationSchema=z.object(reconcileMutationInputSchema).strict();
export function mutationReadTarget(record) {
 const args=record.operationInput,keys=new Set(),ids=new Set();
 if(record.name==='render_screen'){
  keys.add(args.spec.key);if(args.parentId)ids.add(args.parentId);
 }else for(const patch of args.patches){if(patch.key)keys.add(patch.key);if(patch.id)ids.add(patch.id);for(const n of patch.append||[])keys.add(n.key);}
 return {fileKey:record.fileKey,keys:[...keys],ids:[...ids]};
}
export function buildMutationReadbackCode(target){return `
const target=${JSON.stringify(target)};
if(figma.fileKey!==target.fileKey)throw Error('Recovery file mismatch');
await figma.loadAllPagesAsync();
const previous=figma.skipInvisibleInstanceChildren;figma.skipInvisibleInstanceChildren=false;
try{
 const pages=[...figma.root.children],matches=[];let scannedNodes=0;
 function visit(node){
  if(++scannedNodes>100000)throw Error('Recovery traversal incomplete');
  const key=node.getPluginData?.('codex-spec-key')||'';
  if(target.keys.includes(key)||target.ids.includes(node.id))matches.push({id:node.id,key,type:node.type,parentId:node.parent?.id||null});
  if('children' in node)for(const child of node.children)visit(child);
 }
 for(const page of pages){if(page.type!=='PAGE')throw Error('Invalid page');visit(page);}
 if(figma.fileKey!==target.fileKey)throw Error('Recovery file changed');
 return {fileKey:target.fileKey,keys:target.keys,ids:target.ids,matches,coverage:{complete:true,pageIds:pages.map(p=>p.id),scannedNodes}};
}finally{figma.skipInvisibleInstanceChildren=previous;}`;}
