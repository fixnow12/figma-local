import {readFile,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {planPatchRecovery} from '../src/patch-recovery.mjs';
try {
 const {values}=parseArgs({options:{operation:{type:'string'},read:{type:'string'},output:{type:'string'}}});
 if(!values.operation||!values.read)throw Error('Usage: node scripts/plan-patch-recovery.mjs --operation saved-operation.json --read full-read.json [--output plan.json]');
 const plan=planPatchRecovery({operation:JSON.parse(await readFile(values.operation,'utf8')),readback:JSON.parse(await readFile(values.read,'utf8'))});
 const json=JSON.stringify(plan,null,2)+'\n';
 if(values.output)await writeFile(values.output,json,{flag:'wx',mode:0o600});
 console.log(json);
}catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
