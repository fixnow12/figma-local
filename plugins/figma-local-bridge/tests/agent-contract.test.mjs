import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { helpTools, main } from '../scripts/tool-help.mjs';
import { decodeToolResult } from '../src/client-result.mjs';
import { normalizeScreenSpec, parseRenderScreenInput, patchNodesSchema } from '../src/schemas.mjs';
import { toolFailure } from '../src/tool-results.mjs';
import { buildPatchCode } from '../src/figma-code.mjs';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';

test('all compact help examples pass the actual strict parser; schemas are opt-in', async () => {
  for (const [name, tool] of Object.entries(helpTools)) {
    assert.doesNotThrow(() => tool.parse ? tool.parse(tool.example) : tool.schema.parse(tool.example));
    const help = await main([name]);
    assert.deepEqual(help.example, tool.example);
    assert.equal(help.properties, undefined);
    const schema = await main([name, '--schema']);
    assert.ok(schema.properties);
  }
  patchNodesSchema.parse({patches:[{key:'title',set:{fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]}}]});
});

test('recorded wrong render forms fail offline, including explicit free-layout hug', () => {
  const base = helpTools.render_screen.example;
  const badNodes = [
    {key:'a',name:'A',type:'frame',parentKey:{key:'card'}},
    {key:'a',name:'A',type:'screen'},
    {key:'a',name:'A',type:'image',data:'AA==',mimeType:'image/png',background:'#FFFFFF'},
    {key:'a',name:'A',type:'frame',layout:{direction:'none'},height:'hug'},
    {key:'a',name:'A',type:'ellipse',fontSize:16},
  ];
  for (const node of badNodes) assert.throws(() => normalizeScreenSpec(parseRenderScreenInput({...base,spec:{...base.spec,nodes:[node]}}).spec));
  assert.throws(() => parseRenderScreenInput({...base,screenshotScale:0.35}));
  assert.throws(() => patchNodesSchema.parse({patches:[{key:'a',color:'#FFFFFF'}]}));
  assert.throws(() => patchNodesSchema.parse({patches:[{key:'a',set:{fill:'#FFFFFF'}}]}));
});

test('JSON plus diagnostic text and internal failure cannot hide a mutation error', () => {
  for (const status of ['not_applied','rolled_back','partial','unknown']) {
    const result = toolFailure(Object.assign(new Error('failure'), {operationStatus:status,code:'FIXTURE',rollbackErrors:[]}));
    assert.equal(result.content.length,2);
    assert.match(result.content[1].text,/failure/);
    const {structuredContent, ...legacy} = result;
    const decoded = decodeToolResult(legacy);
    assert.equal(decoded.isError,true);
    assert.deepEqual(decoded.payload,structuredContent);
    assert.equal(decoded.payload.operationStatus,status);
  }
  const response = {content:[{type:'text',text:JSON.stringify({error:'hidden',operationStatus:'unknown'})}]};
  assert.equal(decodeToolResult(response).isError,true);
  assert.equal(decodeToolResult({structuredContent:{result:{success:false,error:'native failed'}}}).isError,true);
  assert.equal(decodeToolResult({structuredContent:{result:{nodes:[{error:'getter unavailable'}]}}}).isError,false);
  const ambiguous = {content:[{type:'text',text:'{"a":1}'},{type:'text',text:'{"b":2}'}]};
  assert.ok(Array.isArray(decodeToolResult(ambiguous).payload));
});

test('native typography preflight prevents earlier writes; runtime rollback survives client decoding', async () => {
  const mock = createFigmaMock();
  const first = mock.make('FRAME',{name:'Before'});
  const marker = mock.make('ELLIPSE');
  mock.writes.length=0;
  await assert.rejects(executeGenerated(mock.figma,buildPatchCode({patches:[
    {id:first.id,set:{name:'After'}},{id:marker.id,set:{fontSize:20}},
  ]})),/только для TEXT/);
  assert.equal(first.name,'Before');
  assert.equal(mock.writes.length,0);
  mock.rejectWrites((node,field,value)=>node.id===marker.id&&field==='opacity'&&value===0.5);
  try {
    await executeGenerated(mock.figma,buildPatchCode({patches:[
      {id:first.id,set:{name:'After'}},{id:marker.id,set:{opacity:0.5}},
    ]}));
    assert.fail('expected rollback');
  } catch(error) {
    assert.equal(error.operationStatus,'rolled_back');
    assert.equal(decodeToolResult(toolFailure(error)).payload.operationStatus,'rolled_back');
    assert.equal(first.name,'Before');
  }
});

test('real screenshot handler reports requested/effective scale and cap for large frame and detail',async()=>{
  const source=await readFile(new URL('../src/figma-plugin/code.js',import.meta.url),'utf8');
  const start=source.indexOf("else if (msg.type === 'CAPTURE_SCREENSHOT')");
  const end=source.indexOf('\n  // ============================================================================\n  // GET_FILE_INFO',start);
  assert.ok(start>0&&end>start);
  const run=new (Object.getPrototypeOf(async function(){}).constructor)('figma','msg','console',source.slice(start,end).replace(/^else if/,'if'));
  for(const [width,height,requested,effective] of [[4160,1500,1,1568/4160],[390,844,1,1],[300,200,2,2]]){
    let exported,message;
    const node={id:'1:2',type:'FRAME',name:'Fixture',width,height,children:[],exportAsync:async settings=>{exported=settings;return new Uint8Array([1]);}};
    const figma={getNodeByIdAsync:async()=>node,base64Encode:()=> 'AQ==',ui:{postMessage:value=>message=value}};
    await run(figma,{type:'CAPTURE_SCREENSHOT',nodeId:node.id,scale:requested},{log(){},error(){}});
    assert.equal(message.success,true);
    assert.equal(message.image.requestedScale,requested);
    assert.equal(message.image.effectiveScale,effective);
    assert.equal(message.image.scale,effective);
    assert.equal(exported.constraint.value,effective);
    assert.equal(message.image.maxDimension,1568);
    assert.equal(message.image.capped,effective<requested);
    if(message.image.capped)assert.match(message.image.formatAdvice,/Overview only/);
  }
});
