import {z} from 'zod';
export const recoverComponentDryRunInputSchema={
 fileKey:z.string().min(1).max(160),operationId:z.string().uuid(),argsHash:z.string().regex(/^[a-f0-9]{64}$/),
};
export const recoverComponentDryRunSchema=z.object(recoverComponentDryRunInputSchema).strict();
export function buildComponentDryRunReadbackCode({fileKey,key}) {
 return `const target=${JSON.stringify({fileKey,key})};
if(figma.fileKey!==target.fileKey)throw Error('Recovery target changed');
await figma.loadAllPagesAsync();
const previous=figma.skipInvisibleInstanceChildren;
figma.skipInvisibleInstanceChildren=false;
try{
 const pages=[...figma.root.children],matches=[];let visited=0;
 function visit(node){
  if(++visited>100000)throw Error('Recovery readback exceeds complete traversal budget');
  if(node.getPluginData?.('codex-spec-key')===target.key)matches.push(node.id);
  if('children' in node)for(const child of node.children)visit(child);
 }
 for(const page of pages){if(page.type!=='PAGE')throw Error('Invalid recovery page');visit(page);}
 if(figma.fileKey!==target.fileKey)throw Error('Recovery target changed');
 return {fileKey:target.fileKey,key:target.key,matchIds:matches,coverage:{complete:true,pageIds:pages.map(page=>page.id),scannedNodes:visited}};
}finally{figma.skipInvisibleInstanceChildren=previous;}
`;
}
