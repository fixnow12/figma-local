import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildRenderCode,buildPatchCode} from '../src/figma-code.mjs';
import {createFigmaMock} from './helpers/figma-mock.mjs';

const font={family:'Factor IO',style:'Bold'};
const spec={type:'screen',key:'font-test',name:'Font test',width:600,height:400,children:[{type:'text',key:'title',name:'Title',content:'Шрифт',fontFamily:font.family,fontStyle:font.style}]};
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function harness(mock,globals={}){
 const source=readFileSync(new URL('../src/figma-plugin/code.js',import.meta.url),'utf8');
 const start=source.indexOf('var executeCodeQueue = Promise.resolve();');
 const end=source.indexOf('\n  // ============================================================================\n  // UPDATE_VARIABLE',start);
 assert.ok(start>0&&end>start);
 const messages=[],timers=new Set();let notifyResult;
 mock.figma.ui={postMessage:m=>{messages.push(m);if(m.type==='EXECUTE_CODE_RESULT')notifyResult?.(m);}};
 const registryDeclarations=['catalogTraversalRegistry'].map(name=>source.match(new RegExp('^var '+name+' = .*;$','m'))?.[0]??'').join('\n');
 vm.runInNewContext(registryDeclarations+'\n'+source.slice(start,end)+'\n};',{figma:mock.figma,console:{log(){},warn(){},error(){}},setTimeout:(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn();},ms===8000?5:ms);timers.add(t);return t;},clearTimeout:t=>{timers.delete(t);clearTimeout(t);},...globals});
 let seq=0;
 return {messages,timers,result(){return new Promise(resolve=>{notifyResult=resolve;});},async run(code,timeout=1000){const requestId=String(++seq);await mock.figma.ui.onmessage({type:'EXECUTE_CODE',requestId,code,timeout});return messages.find(m=>m.requestId===requestId&&m.type==='EXECUTE_CODE_RESULT');},async status(){await mock.figma.ui.onmessage({type:'GET_EXECUTION_STATUS',requestId:'status'});return messages.filter(m=>m.type==='GET_EXECUTION_STATUS_RESULT').at(-1);}};
}
const render=()=>buildRenderCode({spec,dryRun:true});

test('hung load is dispatched once, remains observable after timeout, and blocks duplicate native dispatch',async()=>{
 const m=createFigmaMock(),gate=deferred();let loads=0,lists=0;
 m.figma.loadFontAsync=()=>{loads++;return gate.promise;};
 m.figma.listAvailableFontsAsync=async()=>{lists++;return [{fontName:font}];};
 const h=await harness(m);m.writes.length=0;
 try{
  const first=await h.run(render());assert.equal(first.code,'FONT_SERVICE_TIMEOUT');assert.equal(first.operationStatus,'not_applied');
  assert.equal(loads,1,'timeout must not dispatch another native load');assert.equal(lists,0,'timeout is not a settled missing-font rejection');
  const status=await h.status();assert.equal(status.busy,false);assert.equal(status.pendingExecutions,0);assert.equal(status.fontService.pendingCount,1);assert.equal(status.fontService.pending[0].timedOut,true);assert.equal(status.fontService.pending[0].family,font.family);
  const second=await h.run(render());assert.equal(second.code,'FONT_SERVICE_PENDING');assert.equal(loads,1);assert.equal(m.writes.filter(w=>w.field!=='selection').length,0);assert.equal(m.page.selection.length,0);assert.equal(h.timers.size,0);
 }finally{gate.resolve();}
 await new Promise(setImmediate);
 assert.equal((await h.status()).fontService.pendingCount,0);assert.equal(m.writes.filter(w=>w.field!=='selection').length,0,'late completion cannot resume abandoned render');
 assert.equal(m.page.selection.length,0); // Existing rollback restores the same selection, even before node creation.
 m.figma.loadFontAsync=async()=>{loads++;};assert.equal((await h.run(render())).result.ready,true,'settled native state removes stale failure');
});

test('settled native rejection plus empty catalogue is typed missing; next execution can recover',async()=>{
 const m=createFigmaMock();m.figma.loadFontAsync=async()=>{throw Error('not found');};m.figma.listAvailableFontsAsync=async()=>[];
 const h=await harness(m);const response=await h.run(render());assert.equal(response.code,'FONT_NOT_AVAILABLE');assert.equal(response.operationStatus,'not_applied');
 assert.equal((await h.status()).fontService.pendingCount,0);
 m.figma.loadFontAsync=async()=>{};assert.equal((await h.run(render())).result.ready,true);
});

test('advertised but rejected font is load failure, never missing or timeout',async()=>{
 const m=createFigmaMock();m.figma.loadFontAsync=async()=>{throw Error('native decoder failed');};m.figma.listAvailableFontsAsync=async()=>[{fontName:font}];
 const h=await harness(m);assert.equal((await h.run(render())).code,'FONT_LOAD_FAILED');
});

test('hung catalogue remains tracked and is not redispatched on next execution',async()=>{
 const m=createFigmaMock(),gate=deferred();let lists=0;
 m.figma.loadFontAsync=async()=>{throw Error('style not found');};m.figma.listAvailableFontsAsync=()=>{lists++;return gate.promise;};
 const h=await harness(m);
 try{assert.equal((await h.run(render())).code,'FONT_SERVICE_TIMEOUT');assert.equal((await h.status()).fontService.pending[0].kind,'list');assert.equal((await h.run(render())).code,'FONT_SERVICE_PENDING');assert.equal(lists,1);}finally{gate.reject(Error('late failure'));}
 await new Promise(setImmediate);assert.equal((await h.status()).fontService.pendingCount,0);assert.equal(h.timers.size,0);
});

test('equivalent spelling can resolve only after native rejection; exact family and weight retained',async()=>{
 const m=createFigmaMock(),calls=[];
 const aliasSpec=structuredClone(spec);aliasSpec.children[0].fontStyle='SemiBold';
 m.figma.loadFontAsync=async f=>{calls.push(f);if(f.style==='SemiBold')throw Error('spelling');};
 m.figma.listAvailableFontsAsync=async()=>[{fontName:{family:font.family,style:'Semi Bold'}}];
 const h=await harness(m);assert.equal((await h.run(buildRenderCode({spec:aliasSpec,dryRun:true}))).result.ready,true);assert.deepEqual(calls.map(f=>f.style),['SemiBold','Semi Bold','Regular']);
});

test('cancellation after native load resolves prevents writes and additional loads',async()=>{
 const m=createFigmaMock(),gate=deferred();let loads=0;
 const node=m.make('TEXT',{characters:'До',fontName:font});m.figma.loadFontAsync=()=>{loads++;return gate.promise;};m.writes.length=0;
 const h=await harness(m,{Date:{now:()=>0}});const response=h.result();const run=h.run(buildPatchCode({patches:[{id:node.id,set:{content:'После'}}],ignoreMissing:false}),1);
 assert.equal((await response).code,'PLUGIN_EXECUTION_TIMEOUT');gate.resolve();await run;
 assert.equal(loads,1);assert.equal(m.writes.length,0);assert.equal(node.characters,'До');assert.equal((await h.status()).busy,false);
});

test('unrelated native import still holds queue after outer timeout until settled',async()=>{
 const m=createFigmaMock(),gate=deferred(),events=[];const h=await harness(m,{gate:gate.promise,events,Date:{now:()=>0}});
 const response=h.result();const run=h.run('await gate; if(!executionControl.cancelled) events.push("late-write");',1);
 assert.equal((await response).code,'PLUGIN_EXECUTION_TIMEOUT');assert.equal((await h.status()).busy,true);gate.resolve();await run;assert.deepEqual(events,[]);assert.equal((await h.status()).busy,false);
});
