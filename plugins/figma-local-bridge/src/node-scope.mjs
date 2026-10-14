import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
const id=z.string().min(1).max(160);
export const readNodeScopeInputSchema={fileKey:id,nodeId:id};
export const readNodeScopeSchema=z.object(readNodeScopeInputSchema).strict();

// Exact diagnostic metadata; no page load, descendants or variant getters.
async function readNodeScope(figma,input,access){
 const fail=message=>{throw Object.assign(Error('Node scope: '+message),{code:'NODE_SCOPE_UNAVAILABLE'});};
 const check=()=>{access.check();if(figma.fileKey!==input.fileKey)fail('wrong file');};
 const metadata=n=>({id:n.id,type:n.type,name:n.name});
 check();const node=await access.read(figma.getNodeByIdAsync(input.nodeId),'node scope '+input.nodeId);check();
 if(!node||node.removed||node.id!==input.nodeId||node.type==='DOCUMENT')fail('missing or unsupported node');
 function lineage(){
  check();const rows=[],seen=new Set();let current=node;
  while(current){
   if(current.removed||seen.has(current)||seen.size>=512)fail('invalid or over-budget ancestry');
   if(typeof current.id!=='string'||typeof current.type!=='string'||typeof current.name!=='string')fail('invalid basic metadata');
   seen.add(current);rows.push(current);
   if(current.type==='PAGE'){
    if(!figma.root.children.includes(current)||current.parent!==figma.root)fail('foreign page');return rows;
   }
   current=current.parent;
  }
  fail('page ancestry missing');
 }
 const refs=lineage(),before=refs.map(metadata),currentPageId=figma.currentPage?.id??null;
 let height={status:'not_applicable'};
 if('height' in node)try{
  const value=node.height;if(typeof value!=='number'||!Number.isFinite(value))fail('invalid height');height={status:'available',value};
 }catch(error){height={status:'unavailable',error:{field:'height',message:String(error.message||error)}};}
 const after=lineage();
 if(after.length!==refs.length||after.some((n,i)=>n!==refs[i]||n.id!==before[i].id||n.type!==before[i].type||n.name!==before[i].name))fail('target ancestry changed');
 if((figma.currentPage?.id??null)!==currentPageId)fail('current page changed');check();
 return{schemaVersion:1,kind:'node-scope',catalogEligible:false,fileKey:input.fileKey,node:before[0],ancestry:before.slice(1),page:before.at(-1),currentPageId,height,coverage:{exactNodeOnly:true,ancestryRead:true,descendantsRead:false,pageLoadCalled:false,componentPropertiesRead:false,atomicSnapshot:false}};
}
export const buildReadNodeScopeCode=input=>compileOperation(readNodeScope,input,{readOnly:true});
