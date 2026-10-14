import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
import {buildReadNodeScopeCode,readNodeScopeSchema} from '../src/node-scope.mjs';
import {buildReadComponentMetadataCode} from '../src/component-metadata.mjs';
import {buildReadTextStyleCode} from '../src/read-text-style.mjs';
import {buildExportAssetsCode,exportAssetsSchema} from '../src/export-assets.mjs';
const run=(m,builder,args)=>{m.writes.length=0;return executeGenerated(m.figma,builder(args));};
function scoped(){const m=createFigmaMock();m.figma.fileKey='target';m.page.parent=m.figma.root;const root=m.make('FRAME'),node=m.make('TEXT',{characters:'Hello'},root);m.writes.length=0;return {m,root,node};}
test('node scope reads exact ancestry and reports unavailable height without descendants or page load',async()=>{
 const {m,root,node}=scoped();m.page.loadAsync=()=>{throw Error('page load forbidden');};
 Object.defineProperty(node,'height',{get(){throw Error('native height unavailable');}});
 Object.defineProperty(root,'children',{get(){throw Error('descendants forbidden');}});
 const r=await run(m,buildReadNodeScopeCode,{fileKey:'target',nodeId:node.id});
 assert.equal(r.catalogEligible,false);assert.deepEqual(r.ancestry.map(n=>n.id),[root.id,m.page.id]);assert.equal(r.height.status,'unavailable');assert.equal(r.coverage.pageLoadCalled,false);assert.equal(m.writes.length,0);
});
test('node scope rejects wrong file, ancestry cycle and arbitrary arguments',async()=>{
 const {m,node}=scoped();await assert.rejects(run(m,buildReadNodeScopeCode,{fileKey:'other',nodeId:node.id}),/wrong file/);
 node.parent=node;await assert.rejects(run(m,buildReadNodeScopeCode,{fileKey:'target',nodeId:node.id}),/ancestry/);
 assert.equal(readNodeScopeSchema.safeParse({fileKey:'target',nodeId:node.id,code:'anything'}).success,false);
});
test('component metadata preserves SLOT definitions and skips unavailable variant-child getter',async()=>{
 const {m}=scoped(),definition={Content:{type:'SLOT',slotSettings:{minChildren:0,maxChildren:2},preferredValues:[{type:'COMPONENT',key:'a'.repeat(40)}]}};
 const set=m.make('COMPONENT_SET',{componentPropertyDefinitions:definition}),child=m.make('COMPONENT',{},set);m.writes.length=0;
 Object.defineProperty(child,'componentPropertyDefinitions',{get(){throw Error('variant getter forbidden');}});
 const read=node=>run(m,buildReadComponentMetadataCode,{fileKey:'target',pageId:m.page.id,nodeId:node.id});
 assert.deepEqual((await read(set)).definitions,{status:'available',value:definition});assert.equal((await read(child)).definitions.status,'not_applicable');assert.equal(m.writes.length,0);
});
test('component metadata marks malformed definition unavailable and rejects foreign scope',async()=>{
 const {m}=scoped(),node=m.make('COMPONENT',{componentPropertyDefinitions:{Title:{type:'TEXT',defaultValue:undefined}}});
 let r=await run(m,buildReadComponentMetadataCode,{fileKey:'target',pageId:m.page.id,nodeId:node.id});assert.equal(r.definitions.status,'unavailable');assert.equal(r.definitions.error.code,'COMPONENT_DEFINITIONS_INVALID');
 const other=m.make('PAGE',{},null);m.figma.root.children.push(other);
 await assert.rejects(run(m,buildReadComponentMetadataCode,{fileKey:'target',pageId:other.id,nodeId:node.id}),/outside page/);
});
function styleFixture(){
 const f=scoped();f.node.textStyleId='style:exact';f.node.getStyledTextSegments=()=>[{start:0,end:5,characters:'Hello',textStyleId:'style:exact'}];
 f.style={id:'style:exact',key:'a'.repeat(40),name:'Body',type:'TEXT',remote:true,fontName:{family:'Inter',style:'Regular'},fontSize:16,textDecoration:'NONE',textCase:'ORIGINAL',lineHeight:{unit:'AUTO'},letterSpacing:{unit:'PIXELS',value:0},leadingTrim:'NONE',paragraphIndent:0,paragraphSpacing:0,textWrapStyle:'AUTO',listSpacing:0,hangingPunctuation:false,hangingList:false,boundVariables:{}};
 f.m.figma.getStyleByIdAsync=async()=>f.style;f.args={fileKey:'target',rootId:f.root.id,styleId:f.style.id,nodeIds:[f.node.id]};return f;
}
test('text-style read returns scoped native use without text or mutations',async()=>{
 const f=styleFixture(),r=await run(f.m,buildReadTextStyleCode,f.args);assert.equal(r.complete,true);assert.equal(r.style.key,f.style.key);assert.equal(r.coverage.verifiedNodes,1);assert.equal(r.uses[0].pageId,f.m.page.id);assert.equal(JSON.stringify(r).includes('Hello'),false);assert.equal(f.m.writes.length,0);
});
test('text-style read resolves direct binding identity and collection modes',async()=>{
 const f=styleFixture();f.style.boundVariables={fontSize:{type:'VARIABLE_ALIAS',id:'v'}};
 f.m.figma.variables.getVariableByIdAsync=async()=>({id:'v',key:'b'.repeat(40),resolvedType:'FLOAT',variableCollectionId:'c'});
 f.m.figma.variables.getVariableCollectionByIdAsync=async()=>({id:'c',key:'c'.repeat(40),modes:[{modeId:'day',name:'Day'}],defaultModeId:'day'});
 const r=await run(f.m,buildReadTextStyleCode,f.args);assert.equal(r.dependencies[0].key,'b'.repeat(40));assert.equal(r.dependencies[0].collection.defaultModeId,'day');assert.equal(r.dependencySemantics,'direct-binding-identities-and-collection-modes');
});
for(const mode of ['mixed','incomplete-ranges','foreign-root','missing-field','unknown-structured-field','style-drift','wrong-dependency'])test('text-style read rejects '+mode,async()=>{
 const f=styleFixture();
 if(mode==='mixed')f.node.textStyleId=f.m.figma.mixed;
 if(mode==='incomplete-ranges')f.node.getStyledTextSegments=()=>[{start:0,end:4,characters:'Hell',textStyleId:f.style.id}];
 if(mode==='foreign-root')f.args.rootId=f.m.make('FRAME').id;
 if(mode==='missing-field')delete f.style.leadingTrim;
 if(mode==='unknown-structured-field')f.style.fontName.extra=true;
 if(mode==='style-drift'){let calls=0;f.m.figma.getStyleByIdAsync=async()=>{if(++calls===2)f.style.fontSize=17;return f.style;};}
 if(mode==='wrong-dependency'){f.style.boundVariables={fontSize:{type:'VARIABLE_ALIAS',id:'v'}};f.m.figma.variables.getVariableByIdAsync=async()=>null;}
 const expected={'mixed':/reference missing, mixed/, 'incomplete-ranges':/incomplete range coverage/,'foreign-root':/outside root/,'missing-field':/unsupported enum/,'unknown-structured-field':/unsupported or missing structured field/,'style-drift':/style changed during read/,'wrong-dependency':/missing bound variable/};
 await assert.rejects(run(f.m,buildReadTextStyleCode,f.args),expected[mode]);assert.equal(f.m.writes.length,0);
});
function pngFixture(){const f=scoped();f.bytes=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfH8AAAAASUVORK5CYII=','base64'));f.node.exportAsync=async options=>{assert.deepEqual(options,{format:'PNG',constraint:{type:'SCALE',value:1}});return f.bytes;};f.m.figma.base64Encode=b=>Buffer.from(b).toString('base64');f.args=exportAssetsSchema.parse({fileKey:'target',pageId:f.m.page.id,nodeIds:[f.node.id],format:'png',scale:1,maxBytes:1024});return f;}
test('native PNG keeps exact scale, bytes, geometry and current page',async()=>{const f=pngFixture(),page=f.m.figma.currentPage,r=await run(f.m,buildExportAssetsCode,f.args);assert.equal(r.complete,true);assert.equal(r.assets[0].pixelWidth,1);assert.equal(r.assets[0].data,Buffer.from(f.bytes).toString('base64'));assert.deepEqual(r.assets[0].nativeBounds,{x:0,y:0,width:100,height:40});assert.equal(f.m.figma.currentPage,page);assert.equal(f.m.writes.length,0);});
for(const mode of ['invalid-bytes','budget','drift','wrong-page'])test('native PNG rejects '+mode+' without partial success',async()=>{const f=pngFixture();if(mode==='invalid-bytes')f.bytes=new Uint8Array(50);if(mode==='budget')f.args.maxBytes=1;if(mode==='drift')f.node.exportAsync=async()=>{f.node.width++;return f.bytes;};if(mode==='wrong-page')f.args.pageId='other';await assert.rejects(run(f.m,buildExportAssetsCode,f.args),e=>e.operationStatus==='not_applied');});
