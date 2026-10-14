import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {OperationJournal,operationArgsHash} from '../src/operation-journal.mjs';
const api=await import('../src/nested-swap.mjs').catch(()=>({}));
const key=n=>String(n).repeat(40),copy=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 let count=0,changes=0,afterWrite=null;const nodes=new Map(),events=[];
 const make=(type,props={},parent=null)=>{const n={id:'n:'+ ++count,type,parent,children:[],removed:false,getPluginData:k=>k==='codex-spec-key'?'root':'',...props};nodes.set(n.id,n);if(parent)parent.children.push(n);return n;};
 const page=make('PAGE'),frame=make('FRAME',{},page),library=make('PAGE');
 const component=(k,children=[])=>{const n=make('COMPONENT',{key:k,variantProperties:{}},library);n.template=children;return n;};
 const oldLeaf=component(key(1)),newLeaf=component(key(2)),oldParent=component(key(3)),newParent=component(key(4)),rootSource=component(key(5));
 const instantiate=(source,parent)=>{let main=source;const n=make('INSTANCE',{},parent);n.getMainComponentAsync=async()=>main;
  const fill=()=>{for(const old of n.children)old.removed=true;n.children=[];for(const s of main.template)instantiate(s,n);};
  Object.defineProperty(n,'mainComponent',{set(value){changes++;main=value;fill();afterWrite?.(n,changes);}});fill();return n;};
 oldParent.template=[oldLeaf];newParent.template=[oldLeaf];rootSource.template=[oldParent];instantiate(oldLeaf,newParent);
 const root=instantiate(rootSource,frame),oldChildId=root.children[0].children[0].id;
 const figma={fileKey:'file',currentPage:page,skipInvisibleInstanceChildren:true,getNodeByIdAsync:async id=>nodes.get(id),loadFontAsync:async()=>{},getStyleByIdAsync:async()=>null};
 const input={operationId:'00000000-0000-4000-8000-000000000002',fileKey:'file',pageId:page.id,rootId:root.id,rootKey:'root',rootParentId:frame.id,rootLibraryKey:key(5),rootSourceId:rootSource.id,rootParentKey:'root',creationOperationId:'00000000-0000-4000-8000-000000000001',baselineNested:[{childPath:[0],libraryKey:key(3)},{childPath:[0,0],libraryKey:key(1)}],expectedNested:[{childPath:[0],libraryKey:key(4)},{childPath:[0,0],libraryKey:key(2)}],operationKey:'guide/result/nested',swaps:[{childPath:[0],fromLibraryKey:key(3),sourceId:newParent.id,libraryKey:key(4),variant:{}},{childPath:[0,0],fromLibraryKey:key(1),sourceId:newLeaf.id,libraryKey:key(2),variant:{}}]};
 return {figma,input,root,page,frame,nodes,oldParent,newParent,newLeaf,oldLeaf,oldChildId,events,get changes(){return changes;},setAfterWrite:fn=>afterWrite=fn};
}
async function run(f,input=f.input){assert.equal(typeof api.buildNestedSwapCode,'function','typed nested swap must exist');const args=api.nestedSwapSchema.parse(input);const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;return new AsyncFunction('figma','executionControl',api.buildNestedSwapCode(args))(f.figma,{report:event=>f.events.push(event)});}
test('complete expected identity closure must be required in typed input',()=>{const v=fixture().input;delete v.baselineNested;assert.equal(api.nestedSwapSchema.safeParse(v).success,false);});
test('swap journal rejects a root without a settled creation receipt',()=>{const dir=mkdtempSync(join(tmpdir(),'nested-creation-'));try{const j=new OperationJournal(dir),args=fixture().input;assert.throws(()=>j.begin({fileKey:'file',name:'swap_nested_components',args},'connection'),{code:'NESTED_SWAP_CREATION_MISMATCH'});}finally{rmSync(dir,{recursive:true,force:true});}});
test('typed swap resets parent then re-reads new descendants and proves every target',async()=>{
 const f=fixture(),r=await run(f);assert.equal(f.changes,2);assert.notEqual(f.root.children[0].children[0].id,f.oldChildId);assert.equal((await f.root.children[0].children[0].getMainComponentAsync()).key,key(2));assert.equal(r.rootId,f.root.id);assert.equal(r.coverage.complete,true);assert.equal(r.swaps.length,2);assert.equal(f.events.at(-1).stage,'verified');assert.equal(f.figma.skipInvisibleInstanceChildren,true);
});
for(const [name,mutate] of [
 ['wrong path',f=>f.input.swaps[1].childPath=[0,3]],['wrong from key',f=>f.input.swaps[0].fromLibraryKey=key(8)],
 ['wrong desired key',f=>f.input.swaps[0].libraryKey=key(8)],['wrong variant',f=>{f.input.swaps[0].variant={Size:'xl'};f.input.swaps[0].librarySetKey=key(9);}],
 ['wrong root key',f=>f.input.rootKey='other'],['wrong main root key',f=>f.input.rootLibraryKey=key(8)],
 ['wrong page',f=>f.input.pageId='missing'],['wrong parent',f=>f.input.rootParentId='missing'],['wrong file',f=>f.input.fileKey='other'],
 ['missing source',f=>f.input.swaps[0].sourceId='missing'],['wrong target type',f=>f.root.children[0].type='FRAME'],
 ['source component target',f=>f.input.rootId=f.newParent.id],['incomplete budget',f=>f.input.maxNodes=1],
 ['source cannot provide prospective child path',f=>f.newParent.children=[]],
])test('rejects '+name+' before any assignment',async()=>{const f=fixture();mutate(f);await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.changes,0);});
for(const [name,change] of [['unknown field',v=>v.javascript='arbitrary'],['negative path',v=>v.swaps[0].childPath=[-1]],['duplicate path',v=>v.swaps.push(copy(v.swaps[0]))],['unsorted descendants',v=>v.swaps.reverse()],['invalid key',v=>v.swaps[0].libraryKey='icon-name']])test('strict schema rejects '+name,()=>{assert.ok(api.nestedSwapSchema);const v=fixture().input;change(v);assert.equal(api.nestedSwapSchema.safeParse(v).success,false);});
test('failure after parent replacement stays partial and does not replay or claim rollback',async()=>{const f=fixture();f.setAfterWrite((n,count)=>{if(count===1)n.children=[];});await assert.rejects(run(f),e=>e.operationStatus==='partial');assert.equal(f.changes,1);assert.equal(f.events.length,0);});
test('final read detects replacement identity drift as partial',async()=>{const f=fixture();f.setAfterWrite((n,count)=>{if(count===2)n.getMainComponentAsync=async()=>f.oldLeaf;});await assert.rejects(run(f),e=>e.operationStatus==='partial');assert.equal(f.changes,2);});
test('journal prevents repeated stable operation across settled success and restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nested-journal-'));try{let j=new OperationJournal(dir);const args=fixture().input;const input={fileKey:'file',name:'swap_nested_components',args};creation(j,args);const first=j.begin(input,'connection');j.mark(first.operationId,{settled:true,state:'verified',operationStatus:'applied',resourceId:args.rootId});j=new OperationJournal(dir);assert.throws(()=>j.begin(input,'new'),e=>e.code==='OPERATION_ALREADY_EXISTS'&&e.operationId===first.operationId);assert.throws(()=>j.begin({...input,args:{...args,rootId:'changed'}},'new'),{code:'OPERATION_ARGUMENTS_MISMATCH'});}finally{rmSync(dir,{recursive:true,force:true});}
});
test('journal prevents repeat while unknown and never hides original pending record',()=>{const dir=mkdtempSync(join(tmpdir(),'nested-journal-'));try{const j=new OperationJournal(dir),input={fileKey:'file',name:'swap_nested_components',args:fixture().input};creation(j,input.args);const first=j.begin(input,'connection');j.mark(first.operationId,{state:'unknown',operationStatus:'unknown',commandSent:true});assert.throws(()=>j.begin(input,'new'),e=>e.code==='OPERATION_ALREADY_EXISTS'&&e.operationId===first.operationId);assert.equal(j.get('file',first.operationId).settled,false);}finally{rmSync(dir,{recursive:true,force:true});}});

function creation(j,a){const operationInput={fileKey:a.fileKey,key:a.rootKey,parentKey:a.rootParentKey,sourceId:a.rootSourceId};j.save({schemaVersion:2,operationId:a.creationOperationId,fileKey:a.fileKey,name:'use_component',stage:'verified',argsHash:operationArgsHash({fileKey:a.fileKey,name:'use_component',args:operationInput}),settled:true,state:'verified',operationStatus:'applied',commandSent:true,resourceId:a.rootId,operationInput});}

test('unlisted baseline INSTANCE is rejected before assignment',async()=>{const f=fixture();f.input.baselineNested.pop();await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.changes,0);});
test('unreachable expected final identity blocks before all assignments',async()=>{const f=fixture();f.input.expectedNested[1].libraryKey=key(9);await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.changes,0);assert.equal(f.events.length,0);});
