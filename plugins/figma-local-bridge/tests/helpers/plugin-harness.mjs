import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

export const turn=()=>new Promise(setImmediate);
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

// Runs the unchanged plugin queue and status handler in a VM. A manual clock
// makes timeout/cancellation order reproducible without live Figma or servers.
export function harness(figma,globals={}){
 const source=readFileSync(new URL('../../src/figma-plugin/code.js',import.meta.url),'utf8');
 const start=source.indexOf('var executeCodeQueue = Promise.resolve();');
 const end=source.indexOf('\n  // ============================================================================\n  // UPDATE_VARIABLE',start);
 assert.ok(start>0&&end>start);
 const declarations=['catalogTraversalRegistry','catalogPrewarmRegistry'].map(n=>source.match(new RegExp('^var '+n+' = .*;$','m'))?.[0]??'').join('\n');
 let now=1000,sequence=0,timerSequence=0;
 const timers=new Map(),messages=[],results=new Map();
 figma.ui={postMessage:m=>{messages.push(m);if(m.type==='EXECUTE_CODE_RESULT')results.get(m.requestId)?.resolve(m);}};
 const context=vm.createContext({figma,console:{log(){},warn(){},error(){}},Date:{now:()=>now},
   setTimeout:(fn,ms)=>{const id=++timerSequence;timers.set(id,{fn,at:now+ms,ms});return id;},clearTimeout:id=>timers.delete(id),...globals});
 vm.runInContext(declarations+'\n'+source.slice(start,end)+'\n};',context);
 return {messages,timers,context,
   async advance(ms){const end=now+ms;for(;;){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await turn();}now=end;await turn();},
   start(code,timeout=30000){const requestId=String(++sequence),result=deferred();results.set(requestId,result);const done=figma.ui.onmessage({type:'EXECUTE_CODE',requestId,code,timeout,operation:{name:'offline-review',mutating:true}});return {done,result:result.promise};},
   async status(){await figma.ui.onmessage({type:'GET_EXECUTION_STATUS',requestId:'status'});return messages.filter(m=>m.type==='GET_EXECUTION_STATUS_RESULT').at(-1);}
 };
}
