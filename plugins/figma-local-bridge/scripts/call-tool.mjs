// A typed MCP client for local diagnostics and clients with a stale tool catalog.
// It connects to the same server as the plugin; no direct canvas execution.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {claimEvidence,writeEvidence,compactReceipt} from '../src/call-evidence.mjs';
import { decodeToolResult } from '../src/client-result.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'plugin-root': { type: 'string' }, args: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  'read-response': { type: 'string' },
} });
if (values.help) {
  console.log(`Typed Bridge client (no direct canvas execution)
Usage: node scripts/call-tool.mjs TOOL --args FILE --output DIR
       node scripts/call-tool.mjs list [TOOL]
       node scripts/call-tool.mjs --read-response response.json (offline; no replay)
       node scripts/tool-help.mjs TOOL [--schema | --validate FILE] (offline)
Options: --plugin-root DIR, --help (-h)
Example: node scripts/call-tool.mjs inspect_selection --args inspect.json --output ./inspection
inspect.json: {"fileKey":"TARGET_FILE","nodeId":"1:2","depth":2,"detail":"full"}
Arguments are read from --args FILE. Positional JSON is not supported.`);
  process.exit(0);
}
if (values['read-response']) {
  if (positionals.length || values.args || values.output) throw new Error('--read-response cannot be combined with a tool, --args or --output');
  const decoded = decodeToolResult(JSON.parse(await readFile(resolve(values['read-response']), 'utf8')));
  console.log(JSON.stringify(decoded, null, 2));
  process.exit(decoded.isError ? 1 : 0);
}
const maximumPositionals = positionals[0] === 'list' ? 2 : 1;
if (positionals.length > maximumPositionals) {
  console.error(JSON.stringify({error:'Unexpected positional arguments; use --args FILE for tool arguments. Listing accepts only: list [TOOL].',responseReceived:false}));
  process.exit(1);
}
const explicitOutput = Boolean(values.output);
const pluginRoot = resolve(values['plugin-root'] || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const config = JSON.parse(await readFile(resolve(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['figma-local'];
const client = new Client({ name: 'figma-local-tool-client', version: '1.0.0' });
const transport = new StdioClientTransport({ command: config.command, args: config.args,
  cwd: resolve(pluginRoot, config.cwd || '.'), env: { ...process.env, ...config.env }, stderr: 'pipe' });
// Keep bounded diagnostic evidence; never print credentials from server stderr.
const sanitize = text => String(text)
  .replace(/(authorization\s*:\s*)(?:bearer\s+|basic\s+)?[^\r\n]+/gi, '$1[REDACTED]')
  .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
  .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
let stderr = '';
let evidence;
const outcome = { responseReceived: false, isError: null, exitCode: 0, error: null };
transport.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
try {
  const name=positionals[0];
  const args=values.args?JSON.parse(await readFile(resolve(values.args),'utf8')):{};
  if(name && name!=='list') {
    if(['render_screen','patch_nodes'].includes(name)&&args.dryRun!==true)args.operationId ||= randomUUID();
    evidence=await claimEvidence({output:values.output,tool:name,args,inputPath:values.args});
    console.error(JSON.stringify({evidence:evidence.directory,operationId:args.operationId,
      compact:evidence.automatic,nextStep:'Read saved response.json; after timeout read get_operation_status and affected nodes. Do not replay this runner.'}));
  }
  await client.connect(transport, { timeout: 10000 });
  const { tools } = await client.listTools();
  if (!name || name === 'list') {
    const selected = positionals[1] ? tools.filter(tool => tool.name === positionals[1]) : tools;
    if (!selected.length) throw new Error(`Инструмент ${positionals[1]} отсутствует в ${pluginRoot}`);
    console.log(JSON.stringify(selected, null, 2));
  } else {
    if (!tools.some(tool => tool.name === name)) throw new Error(`Инструмент ${name} отсутствует в ${pluginRoot}`);
    // Never retry calls: a timeout does not prove that a mutation was not applied.
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
    outcome.responseReceived = true;
    const { payload, isError, error: resultError } = decodeToolResult(response);
    outcome.isError = isError;
    outcome.exitCode = isError ? 1 : 0;
    if (evidence) {
      const output=evidence.directory;
      const savedPayload=evidence.automatic?compactReceipt(payload):payload;
      const savedResponse=evidence.automatic?{isError,structuredContent:savedPayload,content:[]}:response;
      await writeEvidence(resolve(output,'response.json'),JSON.stringify(savedResponse,null,2));
      await writeEvidence(resolve(output,'result.json'),JSON.stringify(savedPayload,null,2));
      if (!evidence.automatic) {
        let index=0;
        for(const item of response.content||[])if(item.type==='image'&&item.mimeType==='image/png'){
          const path=resolve(output,`preview-${index++}.png`);
          await writeEvidence(path,Buffer.from(item.data,'base64'));
          console.log(JSON.stringify({image:path}));
        }
      }
      if(explicitOutput)console.log(JSON.stringify({result:resolve(output,'result.json'),isError,
        operationStatus:payload?.operationStatus,rootId:payload?.result?.rootId,error:resultError,verification:payload?.result?.verification,ready:payload?.ready,
        nextStep:'Read saved response.json/result.json; never replay a mutation to reveal its error.'}));
      else console.log(JSON.stringify(payload,null,2));
    } else console.log(JSON.stringify(payload,null,2));
    if (isError) process.exitCode = 1;
  }
 } catch (error) {
  outcome.exitCode = 1;
  outcome.error = sanitize(error.message || error).slice(0, 2048);
  process.exitCode = 1;
  console.error(JSON.stringify({ error: outcome.error, responseReceived: outcome.responseReceived }));
} finally {
  try { await client.close(); } catch (error) {
    outcome.exitCode = 1;
    outcome.error ||= sanitize(error.message || error).slice(0, 2048);
    process.exitCode = 1;
  }
  if (evidence) {
    // A clipped first line may start halfway through a credential; discard it.
    const bounded=stderr.length>=16384?(stderr.includes('\n')?stderr.slice(stderr.indexOf('\n')+1):''):stderr;
    await writeEvidence(resolve(evidence.directory,'transport.json'),JSON.stringify({...outcome,stderr:sanitize(bounded).slice(-8192)},null,2));
  }
}
