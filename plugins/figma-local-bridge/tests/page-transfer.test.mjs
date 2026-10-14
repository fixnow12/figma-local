import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildMoveCode } from '../src/scene-operations.mjs';
import { moveNodesSchema, moveNodesInputSchema } from '../src/operation-schemas.mjs';
function fixture() {
 const m=createFigmaMock();m.figma.fileKey='target-file';
 const target=m.make('PAGE',{name:'Target'},null);m.figma.root.children.push(target);
 const a=m.make('SECTION',{x:120,y:240,width:1440,height:900,resize:undefined,layoutMode:undefined});
 const child=m.make('FRAME',{x:0,y:0},a);const text=m.make('TEXT',{characters:'Сохранить'},child);const b=m.make('FRAME',{x:1600,y:240});
 const input={fileKey:'target-file',pageTransfer:{sourcePageId:m.page.id,targetPageId:target.id},moves:[{id:a.id,parentId:target.id},{id:b.id,parentId:target.id}]};
 return {m,target,a,b,child,text,input};
}
const run=(f,input=f.input)=>executeGenerated(f.m.figma,buildMoveCode(input));
test('page transfer schema admits explicit route in public and parsed inputs',()=>{const f=fixture();assert.deepEqual(moveNodesSchema.parse(f.input),f.input);assert.deepEqual(z.object(moveNodesInputSchema).strict().parse(f.input),f.input);});
test('page transfer schema requires file, distinct pages and exact destination',()=>{
 const {input}=fixture();for(const value of [{...input,fileKey:undefined},{...input,pageTransfer:{...input.pageTransfer,targetPageId:input.pageTransfer.sourcePageId}},{...input,moves:[{id:'a',parentId:'wrong'}]},{...input,pageTransfer:{...input.pageTransfer,code:'x'}}])assert.equal(moveNodesSchema.safeParse(value).success,false);
});
test('moves containers preserving identities children and geometry without page switch',async()=>{
 const f=fixture(),ids=[...f.m.nodes.keys()],page=f.m.figma.currentPage;const r=await run(f);
 assert.deepEqual(f.target.children,[f.a,f.b]);assert.deepEqual(f.a.children,[f.child]);assert.equal(f.text.characters,'Сохранить');assert.deepEqual([f.a.x,f.a.y,f.a.width,f.a.height],[120,240,1440,900]);assert.deepEqual([...f.m.nodes.keys()],ids);assert.equal(f.m.figma.currentPage,page);
 assert.deepEqual(r.moved.map(x=>[x.id,x.parentId,x.index]),[[f.a.id,f.target.id,0],[f.b.id,f.target.id,1]]);assert.equal(r.sourcePageId,f.m.page.id);assert.equal(r.targetPageId,f.target.id);
});
test('loads exact subtree fonts before any mutation',async()=>{
 const f=fixture();f.text.fontName={family:'Factor IO',style:'Regular'};f.m.figma.loadFontAsync=async font=>{assert.equal(f.a.parent,f.m.page);assert.deepEqual(font,f.text.fontName);throw new Error('font unavailable');};
 await assert.rejects(run(f),e=>e.operationStatus==='not_applied'&&/font unavailable/.test(e.message));assert.equal(f.a.parent,f.m.page);assert.equal(f.target.children.length,0);
});
test('second move failure restores page order and SECTION bounds',async()=>{
 const f=fixture(),original=[...f.m.page.children];let failed=false;
 f.m.rejectWrites((n,k,v)=>{if(!failed&&n.id===f.target.id&&k==='children'&&v.includes(f.b)){failed=true;return true;}return false;});
 await assert.rejects(run(f),e=>e.operationStatus==='rolled_back');assert.deepEqual(f.m.page.children,original);assert.deepEqual(f.target.children,[]);assert.equal(f.a.parent,f.m.page);assert.deepEqual([f.a.x,f.a.y,f.a.width,f.a.height],[120,240,1440,900]);
});
test('nested sources component definitions and wrong source pages reject before writes',async()=>{
 for(const kind of ['nested','component','page']){const f=fixture();if(kind==='nested')f.input.moves=[{id:f.child.id,parentId:f.target.id}];if(kind==='component')f.m.make('COMPONENT',{},f.child);if(kind==='page')f.input.pageTransfer.sourcePageId=f.target.id;f.m.writes.length=0;await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.m.writes.length,0);}
});
test('rejects destination outside this document',async()=>{const f=fixture();f.m.figma.root.children=f.m.figma.root.children.filter(x=>x!==f.target);f.m.writes.length=0;await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.m.writes.length,0);});
test('detects structure drift during font reads before moving',async()=>{const f=fixture();f.m.figma.loadFontAsync=async()=>{f.m.page.insertChild(0,f.b);};await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.target.children.length,0);});
test('resolved variable mode drift after reparent causes rollback',async()=>{const f=fixture();Object.defineProperty(f.child,'resolvedVariableModes',{get(){return {c:f.a.parent===f.target?'dark':'light'};},configurable:true});await assert.rejects(run(f),e=>e.operationStatus==='rolled_back'&&/mode|режим/i.test(e.message));assert.equal(f.a.parent,f.m.page);});
test('explicit placement and final indices are returned',async()=>{const f=fixture(),existing=f.m.make('FRAME',{},f.target);f.input.moves[0].position={x:0,y:0};f.input.moves[0].index=0;f.input.moves[1].index=0;const r=await run(f);assert.deepEqual(f.target.children,[f.b,f.a,existing]);assert.deepEqual(r.moved.map(x=>x.index),[1,0]);assert.equal(f.a.x,0);});
test('ordinary move still rejects cross-page parenting',async()=>{const f=fixture();delete f.input.pageTransfer;await assert.rejects(run(f),e=>e.operationStatus==='not_applied');assert.equal(f.target.children.length,0);});
test('failed rollback reports partial',async()=>{const f=fixture();let phase=false;f.m.rejectWrites((n,k,v)=>{if(k!=='children')return false;if(n.id===f.target.id&&v.includes(f.b)){phase=true;return true;}return phase&&n.id===f.m.page.id&&v.includes(f.a);});await assert.rejects(run(f),e=>e.operationStatus==='partial'&&e.rollbackErrors.length>0);});
test('page transfer capability appears only for ready exact file runtime',async()=>{
 const {runtimeDiagnostics,runtimeInfo,pluginRevision}=await import('../src/runtime-info.mjs');
 const status={connected:true,runtime:runtimeInfo,files:[{fileKey:'target',pluginBuild:pluginRevision()}],execution:[{fileKey:'target',responsive:true,busy:false}]};
 assert.ok(runtimeDiagnostics(status,{fileKey:'target'}).capabilities.includes('page-transfer-v1'));
 assert.deepEqual(runtimeDiagnostics({...status,runtime:{revision:'old'}},{fileKey:'target'}).capabilities,[]);
 assert.deepEqual(runtimeDiagnostics(status).capabilities,[]);
});
for(const field of ['x','reactions','characters'])test('descendant '+field+' side effect cannot claim applied or complete rollback',async()=>{
 const f=fixture();const child=field==='characters'?f.text:f.child;const initial=field==='x'?5:field==='reactions'?[{actions:[{type:'NODE',destinationId:f.b.id}]}]:'Исходный текст';child[field]=initial;
 const insert=f.target.insertChild;f.target.insertChild=function(index,node){insert.call(this,index,node);if(node===f.a)child[field]=field==='x'?99:field==='reactions'?[]:'Изменённый текст';};
 await assert.rejects(run(f),e=>e.operationStatus==='partial'&&e.rollbackErrors.length>0);
 assert.equal(f.a.parent,f.m.page);
});
test('mode drift with changed child geometry reports partial after root restoration',async()=>{
 const f=fixture();f.child.x=5;Object.defineProperty(f.child,'resolvedVariableModes',{get(){return {c:f.a.parent===f.target?'dark':'light'};},configurable:true});
 const insert=f.target.insertChild;f.target.insertChild=function(i,n){insert.call(this,i,n);if(n===f.a)f.child.x=99;};
 await assert.rejects(run(f),e=>e.operationStatus==='partial');assert.equal(f.a.parent,f.m.page);assert.equal(f.child.x,99);
});
test('later move changing earlier subtree cannot return success',async()=>{
 const f=fixture();f.child.x=5;const insert=f.target.insertChild;f.target.insertChild=function(i,n){insert.call(this,i,n);if(n===f.b)f.child.x=99;};
 await assert.rejects(run(f),e=>e.operationStatus==='partial');assert.equal(f.a.parent,f.m.page);assert.equal(f.b.parent,f.m.page);
});
