import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
import {fileKeyDescription} from './file-target.mjs';
const id=()=>z.string().min(1).max(512);
export const readTextStyleInputSchema={
 fileKey:z.string().min(1).max(160).describe(fileKeyDescription),
 rootId:id().describe('Точный корень, содержащий все запрошенные TEXT узлы'),
 styleId:id().describe('Непрозрачный native textStyleId; ключ читается из native style'),
 nodeIds:z.array(id()).min(1).max(20).refine(ids=>new Set(ids).size===ids.length,'ID должны быть уникальны'),
};
export const readTextStyleSchema=z.object(readTextStyleInputSchema).strict();

// Serialized into the existing read-only typed operation transport. No imports or mutations.
async function readTextStyle(figma,input,access){
 const fail=message=>{throw Error('TEXT style evidence: '+message);};
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const flags=v=>{
  if(!object(v))fail('expected typed record');
  for(const k of ['error','errors','missing','unread','warnings','fidelityWarnings']){
   const x=v[k];if(x!==undefined&&x!==null&&!(Array.isArray(x)&&x.length===0))fail('failed '+k);
  }
  if(v.complete===false||v.isError===true||v.ok===false||v.success===false||v.truncated===true||v.childrenTruncated===true)fail('failed or incomplete record');
  if(v.coverage!==undefined){if(!object(v.coverage))fail('invalid coverage');flags(v.coverage);}
 };
 const exact=(v,required,optional=[])=>{
  flags(v);const allowed=new Set([...required,...optional]);
  if(Object.keys(v).some(k=>!allowed.has(k))||required.some(k=>!Object.hasOwn(v,k)))fail('unsupported or missing structured field');
 };
 const string=(v,max=512)=>{if(typeof v!=='string'||v.length<1||v.length>max)fail('invalid string');return v;};
 const finite=v=>{if(typeof v!=='number'||!Number.isFinite(v))fail('invalid number');return v;};
 const boolean=v=>{if(typeof v!=='boolean')fail('invalid boolean');return v;};
 const member=(v,allowed)=>{if(!allowed.includes(v))fail('unsupported enum');return v;};
 const key=v=>{if(typeof v!=='string'||!/^[a-f0-9]{40}$/.test(v))fail('invalid published key');return v;};
 const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const target=()=>{access.check();access.stablePage();if(figma.fileKey!==input.fileKey)fail('wrong target file');};
 const read=async(p,label)=>{const result=await access.read(p,label);target();return result;};
 function lineage(node,root){
  let current=node,seen=new Set(),found=false,page=null;const path=[];
  for(let i=0;current&&i<256;i++){
   flags(current);if(current.removed||seen.has(current))fail('removed or cyclic ancestry');seen.add(current);
   string(current.id);path.push(current.id);if(current===root)found=true;
   if(current.type==='PAGE'){
    page=current;if(!Array.isArray(figma.root.children)||!figma.root.children.includes(page)||page.parent!==figma.root)fail('unproven owning page');break;
   }
   const parent=current.parent;if(!parent||!Array.isArray(parent.children)||parent.children.filter(n=>n===current).length!==1)fail('broken ancestry membership');current=parent;
  }
  if(!page||!found)fail('outside root or missing page');return {pageId:page.id,ancestorIds:path};
 }
 function use(node,root){
  target();flags(node);if(node.type!=='TEXT'||node.textStyleId!==input.styleId)fail('TEXT reference missing, mixed or foreign');
  const characters=string(node.characters,10000);const segments=node.getStyledTextSegments(['textStyleId']);
  if(!Array.isArray(segments)||segments.length<1||segments.length>1000)fail('incomplete ranges');
  let cursor=0;const ranges=[];
  const boundary=i=>!(i>0&&i<characters.length&&/[\uD800-\uDBFF]/.test(characters[i-1])&&/[\uDC00-\uDFFF]/.test(characters[i]));
  for(const s of segments){
   exact(s,['start','end','characters','textStyleId']);
   if(!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start!==cursor||s.end<=s.start||s.end>characters.length||!boundary(s.start)||!boundary(s.end)||s.characters!==characters.slice(s.start,s.end)||s.textStyleId!==input.styleId)fail('mixed or invalid UTF-16 range');
   ranges.push({start:s.start,end:s.end,textStyleId:s.textStyleId});cursor=s.end;
  }
  if(cursor!==characters.length)fail('incomplete range coverage');
  return {record:{nodeId:node.id,nodeType:'TEXT',...lineage(node,root),textStyleId:node.textStyleId,utf16Length:characters.length,ranges},characters};
 }
 function spacing(v,auto){
  exact(v,v?.unit==='AUTO'&&auto?['unit']:['unit','value']);
  if(auto&&v.unit==='AUTO')return {unit:'AUTO'};
  return {unit:member(v.unit,['PIXELS','PERCENT']),value:finite(v.value)};
 }
 function font(v){
  exact(v,['family','style'],['variationSettings']);const out={family:string(v.family),style:string(v.style)};
  if(v.variationSettings!==undefined){
   flags(v.variationSettings);const entries=Object.entries(v.variationSettings);if(entries.length>64||entries.some(([axis])=>!/^.{4}$/.test(axis)||!/^[\x20-\x7e]+$/.test(axis)))fail('invalid font axes');
   out.variationSettings=Object.fromEntries(entries.sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,finite(v)]));
  }return out;
 }
 const bindingTypes={fontFamily:'STRING',fontStyle:'STRING',fontWeight:'FLOAT',fontSize:'FLOAT',letterSpacing:'FLOAT',lineHeight:'FLOAT',paragraphSpacing:'FLOAT',paragraphIndent:'FLOAT'};
 function snapshot(style){
  flags(style);if(style.id!==input.styleId||style.type!=='TEXT')fail('wrong native style identity/type');
  const definition={fontName:font(style.fontName),fontSize:finite(style.fontSize),textDecoration:member(style.textDecoration,['NONE','UNDERLINE','STRIKETHROUGH']),textCase:member(style.textCase,['ORIGINAL','UPPER','LOWER','TITLE','SMALL_CAPS','SMALL_CAPS_FORCED']),lineHeight:spacing(style.lineHeight,true),letterSpacing:spacing(style.letterSpacing,false),leadingTrim:member(style.leadingTrim,['NONE','CAP_HEIGHT']),paragraphIndent:finite(style.paragraphIndent),paragraphSpacing:finite(style.paragraphSpacing),textWrapStyle:member(style.textWrapStyle,['AUTO','BALANCE','PRETTY']),listSpacing:finite(style.listSpacing),hangingPunctuation:boolean(style.hangingPunctuation),hangingList:boolean(style.hangingList)};
  if(definition.fontSize<1)fail('invalid font size');
  const bindings=style.boundVariables;const boundVariables={};
  if(bindings!==undefined){
   flags(bindings);
   for(const field of Object.keys(bindings).sort()){
    if(!Object.hasOwn(bindingTypes,field))fail('unsupported style binding field');
    const alias=bindings[field];exact(alias,['type','id']);if(alias.type!=='VARIABLE_ALIAS')fail('invalid alias');
    boundVariables[field]={type:'VARIABLE_ALIAS',id:string(alias.id)};
   }
  }
  return {id:style.id,type:'TEXT',key:key(style.key),remote:boolean(style.remote),name:string(style.name,4096),definition,boundVariables};
 }
 function dependency(variable,collection,id){
  flags(variable);flags(collection);
  if(variable.id!==id||collection.id!==variable.variableCollectionId)fail('wrong dependency identity');
  const modes=collection.modes;
  if(!Array.isArray(modes)||modes.length<1||modes.length>100)fail('incomplete collection modes');
  const modeRows=modes.map(m=>{exact(m,['modeId','name']);return {modeId:string(m.modeId),name:string(m.name)};});
  if(new Set(modeRows.map(m=>m.modeId)).size!==modeRows.length||!modeRows.some(m=>m.modeId===collection.defaultModeId))fail('invalid default mode');
  return {id:variable.id,key:key(variable.key),resolvedType:member(variable.resolvedType,['STRING','FLOAT']),variableCollectionId:string(variable.variableCollectionId),collectionKey:key(collection.key),collection:{id:collection.id,key:collection.key,modes:modeRows,defaultModeId:collection.defaultModeId}};
 }
 target();const root=await read(figma.getNodeByIdAsync(input.rootId),'style root');
 if(!root||root.id!==input.rootId||!['INSTANCE','FRAME','COMPONENT','COMPONENT_SET','SECTION'].includes(root.type))fail('invalid root');
 const rootScope=lineage(root,root);const nodes=[],uses=[];
 for(const id of input.nodeIds){const node=await read(figma.getNodeByIdAsync(id),'style consumer');if(!node||node.id!==id)fail('missing consumer');nodes.push(node);uses.push(use(node,root));}
 const style=await read(figma.getStyleByIdAsync(input.styleId),'referenced TEXT style');const captured=snapshot(style);
 const dependencies=[];
 const ids=[...new Set(Object.values(captured.boundVariables).map(a=>a.id))].sort();
 for(const id of ids){
  const variable=await read(figma.variables.getVariableByIdAsync(id),'style variable');if(!variable)fail('missing bound variable');flags(variable);
  const collection=await read(figma.variables.getVariableCollectionByIdAsync(string(variable.variableCollectionId)),'style variable collection');if(!collection)fail('missing bound collection');
  const row=dependency(variable,collection,id);
  for(const [field,alias] of Object.entries(captured.boundVariables))if(alias.id===id&&row.resolvedType!==bindingTypes[field])fail('wrong bound dependency type');
  dependencies.push(row);
 }
 // Async native reads are not an atomic snapshot. Refuse observable drift before completion.
 const finalDependencies=[];
 for(const id of ids){
  const variable=await read(figma.variables.getVariableByIdAsync(id),'recheck style variable');
  if(!variable)fail('bound variable disappeared');flags(variable);
  const collection=await read(figma.variables.getVariableCollectionByIdAsync(string(variable.variableCollectionId)),'recheck style collection');
  if(!collection)fail('bound collection disappeared');finalDependencies.push({variable,collection,id});
 }
 const finalStyle=await read(figma.getStyleByIdAsync(input.styleId),'recheck TEXT style');
 if(!equal(captured,snapshot(finalStyle)))fail('style changed during read');
 for(let i=0;i<nodes.length;i++)if(!equal(uses[i],use(nodes[i],root)))fail('consumer changed during read');
 for(let i=0;i<finalDependencies.length;i++){const {variable,collection,id}=finalDependencies[i];if(!equal(dependencies[i],dependency(variable,collection,id)))fail('dependency changed during read');}
 if(!equal(rootScope,lineage(root,root)))fail('root moved during read');target();
 return {schemaVersion:1,kind:'referenced-text-style',operationStatus:'read',fileKey:figma.fileKey,rootId:root.id,pageId:rootScope.pageId,style:captured,uses:uses.map(u=>u.record),dependencies,dependencySemantics:'direct-binding-identities-and-collection-modes',complete:true,coverage:{complete:true,requestedNodes:input.nodeIds.length,verifiedNodes:uses.length,rangeCount:uses.reduce((n,u)=>n+u.record.ranges.length,0),styleCount:1,variableCount:dependencies.length},unresolved:[]};
}
export const buildReadTextStyleCode=input=>compileOperation(readTextStyle,readTextStyleSchema.parse(input),{readOnly:true});
