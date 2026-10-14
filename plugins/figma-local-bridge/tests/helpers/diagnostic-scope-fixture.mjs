import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after} from 'node:test';
export const syntheticDiagnosticScope={version:1,
  prewarm:{fileKey:'fixture-prewarm',pageId:'100:1'},
  diagnosticExample:{fileKey:'fixture-diagnostic',pageId:'200:1',parentNodeId:'200:4',nodeIds:['200:2','200:3']},
};
export function installSyntheticDiagnosticScope(){
  const dir=mkdtempSync(join(tmpdir(),'figma-diagnostic-scope-'));
  const path=join(dir,'scope.json'),previous=process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE;
  writeFileSync(path,JSON.stringify(syntheticDiagnosticScope),{mode:0o600});
  process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=path;
  after(()=>{if(previous===undefined)delete process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE;else process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=previous;rmSync(dir,{recursive:true});});
  return {path,dir};
}
