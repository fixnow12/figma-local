import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';

const id=z.string().min(1).max(160);
export const readComponentMetadataInputSchema={fileKey:id,pageId:id,nodeId:id};
export const readComponentMetadataSchema=z.object(readComponentMetadataInputSchema).strict();

// Serialized typed read: exactly one node and its immediate parent, no tree read.
async function readComponentMetadata(figma,input,access){
  const fail=message=>{throw Error('Component metadata: '+message);};
  const target=()=>{access.check();if(figma.fileKey!==input.fileKey)fail('wrong file');};
  const lookup=async id=>{target();const node=await access.read(figma.getNodeByIdAsync(id),'узел '+id);target();if(!node||node.removed||node.id!==id)fail('missing or mismatched node');return node;};
  const page=await lookup(input.pageId);
  if(page.type!=='PAGE'||!figma.root.children.includes(page))fail('wrong page');
  const node=await lookup(input.nodeId);
  if(!['COMPONENT','COMPONENT_SET'].includes(node.type))fail('unsupported node type');
  const parent=node.parent, nodeType=node.type;
  const lineage=()=>{
    target();if(node.removed||page.removed||node.type!==nodeType||node.parent!==parent||page.type!=='PAGE'||!figma.root.children.includes(page))fail('target changed');
    let current=node;const seen=new Set();
    while(current&&current!==page){if(seen.has(current)||seen.size>=512||current.removed)fail('invalid ancestry');seen.add(current);current=current.parent;}
    if(current!==page)fail('outside page');
  };
  lineage();
  const metadata=value=>value?{id:value.id,type:value.type,name:value.name}:null;
  const result={schemaVersion:1,kind:'component-metadata',fileKey:input.fileKey,pageId:page.id,node:metadata(node),parent:metadata(parent),coverage:{exactNodeOnly:true,descendantsRead:false}};
  if(node.type==='COMPONENT'&&parent?.type==='COMPONENT_SET')result.definitions={status:'not_applicable'};
  else {
    try {
      const value=node.componentPropertyDefinitions;
      if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(Error('Invalid componentPropertyDefinitions record'),{code:'COMPONENT_DEFINITIONS_INVALID'});
      const json=JSON.stringify(value,(_key,item)=>{
        if(typeof item==='undefined'||typeof item==='function'||typeof item==='symbol'||typeof item==='bigint'||typeof item==='number'&&!Number.isFinite(item))throw Object.assign(Error('Non-JSON componentPropertyDefinitions'),{code:'COMPONENT_DEFINITIONS_INVALID'});
        return item;
      });
      let bytes=0;
      for(const char of json){const point=char.codePointAt(0);bytes+=point<128?1:point<2048?2:point<65536?3:4;if(bytes>262144)throw Object.assign(Error('componentPropertyDefinitions exceeds 256 KiB'),{code:'COMPONENT_DEFINITIONS_TOO_LARGE'});}
      result.definitions={status:'available',value:JSON.parse(json)};
    }catch(cause){result.definitions={status:'unavailable',error:{code:cause.code||'CATALOG_PROPERTY_UNAVAILABLE',field:'componentPropertyDefinitions',nodeId:node.id,message:String(cause.message||cause)}};}
  }
  lineage();
  return result;
}

export const buildReadComponentMetadataCode=input=>compileOperation(readComponentMetadata,input,{readOnly:true});
