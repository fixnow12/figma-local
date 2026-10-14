// Offline synthetic Plugin API execution and real public SDK normalization.
// Dependencies are explicitly bound to an existing immutable installation; no server connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dependencyRoot=process.env.BRIDGE_TEST_DEPENDENCY_ROOT;
const hook=dependencyRoot && registerHooks({resolve(name,context,next){return name==='zod'?{url:pathToFileURL(join(dependencyRoot,'zod/index.js')).href,shortCircuit:true}:next(name,context);}});
const {useComponentInputSchema,useComponentSchema}=await import('../src/schemas.mjs');
const {buildUseComponentCode}=await import('../src/figma-code.mjs');
const {McpServer}=await import(dependencyRoot ? pathToFileURL(join(dependencyRoot,'@modelcontextprotocol/sdk/dist/esm/server/mcp.js')).href : '@modelcontextprotocol/sdk/server/mcp.js');
hook?.deregister();
const {runToolOperation}=await import('../src/tool-results.mjs');
const {OperationJournal}=await import('../src/operation-journal.mjs');
const {runtimeDiagnostics,sourceRevision,brokerRevision,pluginRevision}=await import('../src/runtime-info.mjs');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const args={fileKey:'offline-file',key:'offline/instance',libraryKey:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',librarySetKey:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',variant:{type:'waiting',size:'small'},dryRun:true};
function fixture(){
 const events=[],page={id:'0:1',type:'PAGE',children:[],selection:[],findAll(){return [];},appendChild(n){this.children.push(n);n.parent=this;}};
 const child={id:'1:2',key:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',type:'COMPONENT',name:'Waiting',variantProperties:{type:'waiting',size:'small'},createInstance(){events.push('create');return {id:'2:3',removed:false,setPluginData(){},setProperties(){},remove(){this.removed=true;events.push('remove');}};}};
 const set={id:'1:1',key:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',type:'COMPONENT_SET',children:[child],componentPropertyDefinitions:{Label:{type:'TEXT'}}};child.parent=set;
 const control={cancelled:false,report:e=>events.push(e)};
 const figma={currentPage:page,mixed:Symbol(),importComponentSetByKeyAsync:async key=>{events.push(['set',key]);return set;},importComponentByKeyAsync:async key=>{events.push(['direct',key]);return child;},getNodeByIdAsync:async id=>id===set.id?set:id===child.id?child:null,viewport:{scrollAndZoomIntoView(){}}};
 return {events,page,child,set,control,figma,run:input=>new AsyncFunction('figma','executionControl',buildUseComponentCode(input))(figma,control)};
}
test('public SDK raw schema preserves set route through handler and durable journal',async()=>{
 const server=new McpServer({name:'offline',version:'0'}),dir=mkdtempSync(join(tmpdir(),'set-journal-'));
 try{
 let record;
 const bridge={runInFile:async(fileKey,fn)=>fn({fileKey}),execute:async(code,options)=>{assert(code.includes('importComponentSetByKeyAsync'));record=new OperationJournal(dir).begin({fileKey:options.fileKey,name:options.operation.name,args:options.operation.operationInput},'offline-connection');return {result:{ready:true}};}};
 const registered=server.registerTool('use_component',{inputSchema:useComponentInputSchema},input=>{const parsed=useComponentSchema.parse(input);return runToolOperation(bridge,parsed,buildUseComponentCode(parsed),{operationName:'use_component',mutating:!parsed.dryRun});});
 const normalized=await server.validateToolInput(registered,args,'use_component');assert.deepEqual(normalized,args);
 const response=await registered.handler(normalized,{});assert.equal(response.isError,undefined);assert.deepEqual(record.operationInput,args);
 assert.deepEqual(new OperationJournal(dir).get(args.fileKey,record.operationId).operationInput,args);
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
test('set dryRun imports exact set, selects exact child and reports identities without instance',async()=>{const f=fixture(),result=await f.run(args);assert.equal(result.sourceId,f.child.id);assert.equal(result.librarySetKey,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.deepEqual(result.componentPropertyDefinitions,f.set.componentPropertyDefinitions);assert.deepEqual(f.events.filter(Array.isArray),[['set','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]);assert(!f.events.includes('create'));assert.equal(f.events.at(-1).stage,'verified');});
for(const [name,alter]of [
 ['wrong set key',f=>f.set.key='other'],['wrong set type',f=>f.set.type='FRAME'],['missing variant',f=>f.child.variantProperties.type='other'],['duplicate variants',f=>f.set.children.push({...f.child,id:'1:3'})],['wrong child key',f=>f.child.key='other'],['non-component',f=>f.child.type='FRAME'],['inherited selector',f=>f.child.variantProperties=Object.create(args.variant)],['import denied',f=>f.figma.importComponentSetByKeyAsync=async()=>{throw Error('Denied');}],
])test('set route fails closed: '+name,async()=>{const f=fixture();alter(f);await assert.rejects(f.run({...args,dryRun:false}));assert(!f.events.some(e=>Array.isArray(e)&&e[0]==='direct'));assert(!f.events.includes('create'));});
for(const input of [{...args,libraryKey:undefined},{...args,variant:{}},{...args,variant:undefined},{...args,librarySetKey:''},{...args,sourceId:'1:2'},{...args,variant:{type:''}},{...args,variant:{'':'waiting'}}])test('invalid set input rejects '+JSON.stringify(input),()=>assert.equal(useComponentSchema.safeParse(input).success,false));
test('direct library and local component/set legacy routes remain usable',async()=>{for(const input of [{...args,librarySetKey:undefined},{key:'offline/local',sourceId:'1:2',dryRun:true},{key:'offline/local',sourceId:'1:1',variant:{type:'waiting'},dryRun:true}]){const f=fixture();assert.equal((await f.run(input)).sourceId,'1:2');if(input.libraryKey)assert.deepEqual(f.events.filter(Array.isArray),[['direct','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']]);else assert.equal(f.events.filter(Array.isArray).length,0);}});
test('set import cancellation preserves import journal stage and prevents instance',async()=>{const f=fixture();f.figma.importComponentSetByKeyAsync=async key=>{f.events.push(['set',key]);f.control.cancelled=true;return f.set;};await assert.rejects(f.run({...args,dryRun:false}),e=>e.code==='OPERATION_CANCELLED_BEFORE_MUTATION'&&e.operationStatus==='not_applied');assert.equal(f.events.at(-1).stage,'component-import');assert(!f.events.includes('create'));});
test('set instance setup failure rolls back created instance',async()=>{const f=fixture();f.page.appendChild=()=>{throw Error('append rejected');};await assert.rejects(f.run({...args,dryRun:false}),e=>e.operationStatus==='rolled_back');assert(f.events.includes('create'));assert(f.events.includes('remove'));});
test('set capability requires current runtime and exact READY idle file',()=>{const status={connected:true,runtime:{brokerRevision:brokerRevision()},files:[{fileKey:'offline-file',pluginBuild:pluginRevision()}],execution:[{fileKey:'offline-file',responsive:true,busy:false}]};assert(runtimeDiagnostics(status,{fileKey:'offline-file'}).capabilities.includes('component-set-import-v1'));for(const s of [{...status,execution:[{fileKey:'offline-file',responsive:true,busy:true}]},{...status,runtime:{brokerRevision:'old'}},{...status,files:[]}])assert(!runtimeDiagnostics(s,{fileKey:'offline-file'}).capabilities.includes('component-set-import-v1'));assert(!runtimeDiagnostics(status).capabilities.includes('component-set-import-v1'));assert.equal(runtimeDiagnostics(status,{fileKey:'offline-file'}).sourceRevision,sourceRevision());});
test('archived genuine input preserved by public SDK, historical journal is not rewritten',async()=>{if(!process.env.BRIDGE_TEST_ARCHIVED_DIAGNOSTIC)return;const diagnostic=JSON.parse(readFileSync(process.env.BRIDGE_TEST_ARCHIVED_DIAGNOSTIC)),before=JSON.stringify(diagnostic);const server=new McpServer({name:'archive-offline',version:'0'});try{const tool=server.registerTool('use_component',{inputSchema:useComponentInputSchema},()=>{});const parsed=useComponentSchema.parse(await server.validateToolInput(tool,diagnostic.input,'use_component'));assert.deepEqual(parsed,diagnostic.input);const f=fixture();f.set.key=parsed.librarySetKey;f.child.key=parsed.libraryKey;f.child.variantProperties=parsed.variant;const result=await f.run(parsed);assert.equal(result.libraryKey,parsed.libraryKey);assert.equal(result.librarySetKey,parsed.librarySetKey);assert(!Object.hasOwn(diagnostic.persistedJournalInput,'librarySetKey'));assert.equal(JSON.stringify(diagnostic),before);}finally{await server.close();}});

test('set instance creation uses selected child and preserves mutation journal stages',async()=>{const f=fixture(),result=await f.run({...args,dryRun:false,position:{x:12,y:34}});assert.equal(result.sourceId,f.child.id);assert.equal(result.parentId,f.page.id);assert.deepEqual(f.events.filter(e=>e?.stage).map(e=>e.stage),['component-import','instance-created','attached','verified']);assert.equal(f.page.children.length,1);assert.equal(f.page.children[0].x,12);assert.equal(f.page.children[0].y,34);assert.deepEqual(f.events.filter(Array.isArray),[['set','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']]);});
test('selector respects every declared exact value; first matching property is insufficient',async()=>{const f=fixture();f.child.variantProperties.size='large';await assert.rejects(f.run(args));assert(!f.events.includes('create'));});
test('schema rejects unrecognized fields and non-string set selectors',()=>{for(const extra of [{unexpected:true},{variant:{type:null}},{variant:{type:1}},{librarySetKey:13}])assert.equal(useComponentSchema.safeParse({...args,...extra}).success,false);});

test('actual SDK tools/list JSON schema exports librarySetKey and selector',async()=>{const server=new McpServer({name:'schema-offline',version:'0'});try{server.registerTool('use_component',{inputSchema:useComponentInputSchema},()=>{});const listed=await server.server._requestHandlers.get('tools/list')({method:'tools/list'},{});assert.equal(listed.tools[0].inputSchema.properties.librarySetKey.type,'string');assert.equal(listed.tools[0].inputSchema.properties.variant.type,'object');assert.equal(listed.tools[0].inputSchema.properties.libraryKey.type,'string');}finally{await server.close();}});
