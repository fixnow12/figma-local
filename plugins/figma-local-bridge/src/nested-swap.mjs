import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
const id=z.string().min(1).max(240),key=z.string().regex(/^[a-f0-9]{40}$/),path=z.array(z.number().int().nonnegative()).min(1).max(16);
const swap=z.object({childPath:path,fromLibraryKey:key,sourceId:id,libraryKey:key,variant:z.record(z.string().min(1)),librarySetKey:key.optional()}).strict();
const identity=z.object({childPath:path,libraryKey:key}).strict();
export const nestedSwapInputSchema={operationId:z.string().uuid(),fileKey:id,pageId:id,rootId:id,rootKey:id,rootParentId:id,rootParentKey:id,rootLibraryKey:key,rootSourceId:id,creationOperationId:z.string().uuid(),operationKey:id,baselineNested:z.array(identity).min(1).max(1000),expectedNested:z.array(identity).min(1).max(1000),swaps:z.array(swap).min(1).max(16),maxNodes:z.number().int().min(1).max(1000).optional()};
export const nestedSwapSchema=z.object(nestedSwapInputSchema).strict().superRefine((input,ctx)=>{
 const seen=new Set();input.swaps.forEach((s,i)=>{const p=JSON.stringify(s.childPath);if(seen.has(p)||i&&input.swaps[i-1].childPath.length>s.childPath.length)ctx.addIssue({code:'custom',message:'Unique parent-before-child paths required',path:['swaps',i]});seen.add(p);if(s.librarySetKey===undefined&&Object.keys(s.variant).length)ctx.addIssue({code:'custom',message:'Variant requires exact component set key',path:['swaps',i]});});
});
async function swapNested(figma,input,access){
 let mutated=false;const previousInvisible=figma.skipInvisibleInstanceChildren;figma.skipInvisibleInstanceChildren=false;
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),sorted=o=>Object.fromEntries(Object.entries(o??{}).sort(([a],[b])=>a.localeCompare(b)));
 const need=(ok,message)=>{if(!ok)throw Error('NESTED_SWAP: '+message);};
 const component=async node=>{need(node?.type==='INSTANCE'&&typeof node.getMainComponentAsync==='function','Expected native INSTANCE');const main=await access.read(node.getMainComponentAsync(),'nested main component '+node.id);need(main?.type==='COMPONENT'&&typeof main.key==='string'&&main.key,'Missing main component');return main;};
 async function tree(node){
  const seen=new Set(),flat=[];
  async function visit(n,parent,index,p){need(n&&!n.removed&&typeof n.id==='string'&&!seen.has(n.id),'Missing or duplicate native node');seen.add(n.id);need(seen.size<=(input.maxNodes??1000),'Complete subtree budget exceeded');if(parent)need(n.parent===parent&&parent.children[index]===n,'Native parent/path changed');
   const children='children' in n?[...n.children]:[];const main=n.type==='INSTANCE'?await component(n):null;const row={id:n.id,type:n.type,path:p,parentId:n.parent?.id,childIds:children.map(c=>c.id),...(main?{mainComponent:{id:main.id,key:main.key}}:{})};flat.push(row);
   for(let i=0;i<children.length;i++)await visit(children[i],n,i,[...p,i]);need(!('children'in n)||equal(n.children.map(c=>c.id),row.childIds),'Subtree changed during complete read');return row;
  }await visit(node,null,0,[]);return flat;
 }
 const at=(root,p)=>p.reduce((n,i)=>{need(n&&Array.isArray(n.children)&&n.children[i]&&n.children[i].parent===n,'Exact child path missing');return n.children[i];},root);
 try{
  need(figma.fileKey===input.fileKey&&access.page.id===input.pageId,'Destination changed');const root=await access.node(input.rootId);
  const stableRoot=async()=>{access.stablePage();access.editable(root);need(figma.fileKey===input.fileKey&&root.type==='INSTANCE'&&root.getPluginData(access.dataKey)===input.rootKey&&root.parent?.id===input.rootParentId&&root.parent.getPluginData(access.dataKey)===input.rootParentKey,'Root identity changed');const main=await component(root);need(main.key===input.rootLibraryKey&&main.id===input.rootSourceId,'Root main component changed');};
  const closure=(tree,expected)=>{const actual=tree.filter(n=>n.path.length&&n.type==='INSTANCE');need(actual.length===expected.length,'Nested identity closure incomplete');const seen=new Set();for(const e of expected){const token=JSON.stringify(e.childPath),n=actual.find(n=>equal(n.path,e.childPath));need(!seen.has(token)&&n?.mainComponent.key===e.libraryKey,'Nested identity closure differs');seen.add(token);}};
  await stableRoot();let current=await tree(root);closure(current,input.baselineNested);const prepared=[];let prospective=current.filter(n=>n.path.length&&n.type==='INSTANCE').map(n=>({childPath:n.path,libraryKey:n.mainComponent.key}));
  for(const s of input.swaps){
   const node=at(root,s.childPath);need((await component(node)).key===s.fromLibraryKey,'Initial nested component differs');
   const source=await access.node(s.sourceId);need(source.type==='COMPONENT'&&source.key===s.libraryKey,'Desired component key differs');
   need(equal(sorted(source.variantProperties),sorted(s.variant)),'Desired variant differs');if(s.librarySetKey)need(source.parent?.type==='COMPONENT_SET'&&source.parent.key===s.librarySetKey,'Desired component set differs');
   const sourceTree=await tree(source),expectedFrom=prospective.find(n=>equal(n.childPath,s.childPath))?.libraryKey;need(expectedFrom,'Desired ancestor cannot provide descendant path');
   const beforeNested=prospective;prospective=prospective.filter(n=>!s.childPath.every((v,i)=>n.childPath[i]===v));prospective.push({childPath:s.childPath,libraryKey:s.libraryKey},...sourceTree.filter(n=>n.path.length&&n.type==='INSTANCE').map(n=>({childPath:[...s.childPath,...n.path],libraryKey:n.mainComponent.key})));
   prepared.push({swap:s,source,sourceTree,expectedFrom,beforeNested,afterNested:prospective});
  }
  closure(prospective.map(n=>({path:n.childPath,type:'INSTANCE',mainComponent:{key:n.libraryKey}})),input.expectedNested);
  await stableRoot();need(equal(await tree(root),current),'Destination changed during preparation');
  const results=[];
  for(const p of prepared){
   await stableRoot();need(equal(await tree(root),current),'Destination changed between swaps');closure(current,p.beforeNested);
   need(p.source.key===p.swap.libraryKey&&equal(sorted(p.source.variantProperties),sorted(p.swap.variant))&&(!p.swap.librarySetKey||p.source.parent?.key===p.swap.librarySetKey),'Source changed before assignment');
   need(equal(await tree(p.source),p.sourceTree),'Desired source subtree changed');
   const node=at(root,p.swap.childPath);need((await component(node)).key===p.expectedFrom,'Fresh descendant identity differs');
   access.stablePage();mutated=true;node.mainComponent=p.source;
   current=await tree(root);closure(current,p.afterNested);const fresh=at(root,p.swap.childPath);const applied=await component(fresh);need(applied.key===p.swap.libraryKey&&applied.id===p.swap.sourceId,'Assignment read-back differs');
   results.push({childPath:p.swap.childPath,fromLibraryKey:p.swap.fromLibraryKey,observedFromLibraryKey:p.expectedFrom,libraryKey:p.swap.libraryKey,sourceId:p.source.id,id:fresh.id});
  }
  await stableRoot();need(equal(await tree(root),current),'Final subtree changed');for(const s of input.swaps){const main=await component(at(root,s.childPath));need(main.key===s.libraryKey&&main.id===s.sourceId,'Final nested identity differs');}closure(current,input.expectedNested);
  if(typeof executionControl!=='undefined'&&executionControl.report)executionControl.report({stage:'verified',id:root.id});
  return {fileKey:input.fileKey,pageId:input.pageId,rootId:root.id,rootKey:input.rootKey,rootLibraryKey:input.rootLibraryKey,operationKey:input.operationKey,swaps:results,coverage:{complete:true,nodes:current.length},nodes:current};
 }catch(error){error.operationStatus=mutated?'partial':'not_applied';error.code='NESTED_SWAP_FAILED';throw error;}finally{figma.skipInvisibleInstanceChildren=previousInvisible;}
}
export const buildNestedSwapCode=input=>compileOperation(swapNested,input);
