import {installSyntheticDiagnosticScope} from './helpers/diagnostic-scope-fixture.mjs';
installSyntheticDiagnosticScope();
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock} from './helpers/figma-mock.mjs';
import {harness} from './helpers/plugin-harness.mjs';
import {buildDiagnosticExampleCode,diagnosticExampleSchema} from '../src/diagnostic-example.mjs';
import {buildCatalogExampleCode} from '../src/catalog-read.mjs';
import {prewarmSchema} from '../src/catalog-prewarm.mjs';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;

test('plugin queue preserves independent catalog, prewarm and font registries',async()=>{
 const m=createFigmaMock(),h=harness(m.figma);
 const op=h.start('return {catalog:!!executionControl.catalogTraversal,prewarm:!!executionControl.catalogPrewarm,font:!!executionControl.fontService};');
 await op.done;const response=await op.result;
 assert.deepEqual(JSON.parse(JSON.stringify(response.result)),{catalog:true,prewarm:true,font:true});
 assert.equal((await h.status()).fontService.pendingCount,0);
});

function diagnosticFixture(){
 const m=createFigmaMock(),page=m.make('PAGE',{id:'200:1'},null),parent=m.make('COMPONENT_SET',{id:'200:4'},page);
 const root=m.make('COMPONENT',{id:'200:2'},parent);m.figma.fileKey='diagnostic-fixture-file';m.figma.root.children=[page];m.figma.currentPage=page;
 Object.defineProperty(root,'variantProperties',{get(){throw Error('source getter unavailable');}});
 const control={cancelled:false,catalogTraversal:{ready:true,generation:0,sessions:new Map(),invalidated:new Map()}};
 const args={fileKey:m.figma.fileKey,pageId:page.id,nodeId:root.id,traversalId:'diag-chat-merge',limit:100};
 m.writes.length=0;return {m,parent,root,control,args};
}
test('exact diagnostic projection retains explicit gaps and never gains catalog eligibility',async()=>{
 const {m,control,args}=diagnosticFixture();let cursor,last;
 for(let i=0;i<20;i++){
  last=await new AsyncFunction('figma','executionControl',buildDiagnosticExampleCode({...args,...(cursor?{cursor}:{})}))(m.figma,control);
  assert.equal(last.catalogEligible,false);assert.equal(last.catalogFull,false);assert.equal(last.complete,undefined);assert.equal(last.propertyCoverage.complete,false);
  cursor=last.nextCursor;if(!cursor)break;
 }
 assert.equal(last.treeComplete,true);assert.ok(last.gaps.some(g=>g.field==='variantProperties'&&g.reason==='skipped-known-source-error'&&g.absenceConfirmed===false));
 assert.equal(m.writes.length,0);
});
test('normal catalog capture retains getter failures and cannot reuse diagnostic snapshot',async()=>{
 const {m,control,args}=diagnosticFixture();
 await new AsyncFunction('figma','executionControl',buildDiagnosticExampleCode(args))(m.figma,control);
 await assert.rejects(new AsyncFunction('figma','executionControl',buildCatalogExampleCode(args))(m.figma,control),/Курсор|измен|устарел/);
 const normal=await new AsyncFunction('figma','executionControl',buildCatalogExampleCode({...args,traversalId:'regular-capture'}))(m.figma,control);
 assert.ok(normal.gaps.some(g=>g.field==='variantProperties'&&g.reason==='property-unavailable'&&g.message==='source getter unavailable'));
 assert.equal(normal.gaps.some(g=>g.reason==='skipped-known-source-error'),false);
 assert.equal(normal.projection,undefined);
 assert.equal(m.writes.length,0);
});
test('diagnostic traversal rejects a root moved outside its configured parent',async()=>{
 const {m,parent,control,args}=diagnosticFixture();parent.id='200:99';m.writes.length=0;
 await assert.rejects(new AsyncFunction('figma','executionControl',buildDiagnosticExampleCode(args))(m.figma,control),/parent changed/);
 assert.equal(m.writes.length,0);
});
test('local diagnostic and prewarm source boundaries stay exact',()=>{
 const {args}=diagnosticFixture();assert.equal(diagnosticExampleSchema.safeParse(args).success,true);
 assert.equal(diagnosticExampleSchema.safeParse({...args,fileKey:'foreign'}).success,false);
 assert.equal(diagnosticExampleSchema.safeParse({...args,nodeId:'foreign'}).success,false);
 assert.equal(diagnosticExampleSchema.safeParse({...args,includePng:true}).success,false);
 assert.equal(prewarmSchema.safeParse({fileKey:'prewarm-fixture-file',pageId:'100:1',prewarmId:'cards-prewarm-merge'}).success,true);
 assert.equal(prewarmSchema.safeParse({fileKey:'foreign',pageId:'100:1',prewarmId:'cards-prewarm-merge'}).success,false);
});
