import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('typed client preserves error envelope, parsed text payload and sanitized transport evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-client-'));
  try {
    const server = join(root, 'server.mjs');
    const sdk = resolve('node_modules/@modelcontextprotocol/sdk/dist/esm');
    await writeFile(server, `import { McpServer } from ${JSON.stringify('file://' + sdk + '/server/mcp.js')};\nimport { StdioServerTransport } from ${JSON.stringify('file://' + sdk + '/server/stdio.js')};\nconst s = new McpServer({name:'fixture',version:'1'});\ns.registerTool('fixture',{},async()=>{ console.error('Authorization: Bearer secret-value\\nTOKEN=super-secret'); return {isError:true,content:[{type:'text',text:JSON.stringify({operationStatus:'not_applied',error:'fixture'})}]}; });\nawait s.connect(new StdioServerTransport());`);
    await writeFile(join(root, '.mcp.json'), JSON.stringify({mcpServers:{'figma-local':{command:process.execPath,args:[server]}}}));
    const listing=spawnSync(process.execPath,['scripts/call-tool.mjs','list','fixture','--plugin-root',root],{encoding:'utf8',timeout:15000});
    assert.equal(listing.status,0);assert.deepEqual(JSON.parse(listing.stdout).map(tool=>tool.name),['fixture']);
    const output = join(root, 'out');
    const result = spawnSync(process.execPath, ['scripts/call-tool.mjs','fixture','--plugin-root',root,'--output',output],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,1);
    assert.deepEqual(JSON.parse(await readFile(join(output,'result.json'),'utf8')), {operationStatus:'not_applied',error:'fixture'});
    assert.equal(JSON.parse(await readFile(join(output,'response.json'),'utf8')).isError,true);
    const transport = JSON.parse(await readFile(join(output,'transport.json'),'utf8'));
    assert.equal(transport.responseReceived,true);
    assert.equal(transport.exitCode,1);
    assert.doesNotMatch(transport.stderr,/secret-value|super-secret/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('typed client archives transport failure without inventing a response or retrying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-client-'));
  try {
    await writeFile(join(root, '.mcp.json'), JSON.stringify({mcpServers:{'figma-local':{command:process.execPath,args:['-e',"console.error('PASSWORD=hidden'); process.exit(7)"]}}}));
    const output = join(root, 'out');
    const result = spawnSync(process.execPath, ['scripts/call-tool.mjs','fixture','--plugin-root',root,'--output',output],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,1);
    const outcome = JSON.parse(await readFile(join(output,'transport.json'),'utf8'));
    assert.equal(outcome.responseReceived,false);
    assert.equal(outcome.exitCode,1);
    assert.ok(outcome.error);
    assert.doesNotMatch(outcome.stderr,/hidden/);
    await assert.rejects(readFile(join(output,'response.json')), {code:'ENOENT'});
    await assert.rejects(readFile(join(output,'result.json')), {code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('typed client help works without reading configuration or starting MCP',()=>{
 const result=spawnSync(process.execPath,['scripts/call-tool.mjs','--help','--plugin-root','/nonexistent/bridge-test'],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);assert.match(result.stdout,/--args FILE/);assert.match(result.stdout,/--output DIR/);assert.match(result.stdout,/inspect_selection/);assert.equal(result.stderr,'');
});
test('saved response is decoded offline without starting a configured server or replaying',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bridge-saved-result-'));
 try{
  const path=join(root,'response.json');
  await writeFile(path,JSON.stringify({content:[
   {type:'text',text:JSON.stringify({error:'saved failure',operationStatus:'unknown'})},
   {type:'text',text:'Diagnostic only'},
  ]}));
  const result=spawnSync(process.execPath,['scripts/call-tool.mjs','--read-response',path,'--plugin-root','/nonexistent/bridge-test'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);
  const decoded=JSON.parse(result.stdout);
  assert.equal(decoded.isError,true);assert.equal(decoded.error,'saved failure');assert.equal(decoded.payload.operationStatus,'unknown');
  assert.equal(result.stderr,'');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('typed client rejects ignored positional JSON before configuration or transport',()=>{
 for(const tail of [['inspect_selection','{"nodeId":"1:2"}'],['inspect_selection','unexpected'],['list','inspect_selection','extra']]){
  const result=spawnSync(process.execPath,['scripts/call-tool.mjs',...tail,'--plugin-root','/nonexistent/bridge-test'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/use --args FILE/);assert.doesNotMatch(result.stderr,/ENOENT|no such file/);
 }
});
