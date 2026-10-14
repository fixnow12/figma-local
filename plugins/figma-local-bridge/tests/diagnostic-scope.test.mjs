import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {diagnosticScopeConfigSchema,readLocalDiagnosticScope} from '../src/catalog-diagnostic-scope.mjs';
import {prewarmSchema,buildPrewarmCode} from '../src/catalog-prewarm.mjs';
import {diagnosticExampleSchema,buildDiagnosticExampleCode} from '../src/diagnostic-example.mjs';
import {syntheticDiagnosticScope,installSyntheticDiagnosticScope} from './helpers/diagnostic-scope-fixture.mjs';
const fixture=installSyntheticDiagnosticScope();
const prewarm={...syntheticDiagnosticScope.prewarm,prewarmId:'cards-prewarm-test'};
const diagnostic={fileKey:'diagnostic-fixture-file',pageId:'200:1',nodeId:'200:2',traversalId:'diag-chat-test'};
test('configured file, page and node boundaries remain exact',()=>{
  assert.equal(prewarmSchema.safeParse(prewarm).success,true);
  assert.equal(diagnosticExampleSchema.safeParse(diagnostic).success,true);
  for(const field of ['fileKey','pageId'])assert.equal(prewarmSchema.safeParse({...prewarm,[field]:'999:9'}).success,false);
  for(const field of ['fileKey','pageId','nodeId'])assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,[field]:'999:9'}).success,false);
  assert.match(buildPrewarmCode(prewarm),/prewarm-fixture-file/);
  assert.match(buildDiagnosticExampleCode(diagnostic),/diagnostic-fixture-file/);
});
test('missing configuration fails before code generation',()=>{
  process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=join(fixture.dir,'missing.json');
  try{assert.throws(()=>buildPrewarmCode(prewarm),/missing or invalid/);assert.throws(()=>buildDiagnosticExampleCode(diagnostic),/missing or invalid/);}
  finally{process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=fixture.path;}
});
test('invalid config is redacted and a missing operation stays disabled',()=>{
  const invalid=join(fixture.dir,'invalid.json');writeFileSync(invalid,'{"private-marker":');
  process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=invalid;
  try{assert.throws(()=>readLocalDiagnosticScope('prewarm'),error=>/missing or invalid/.test(error.message)&&!error.message.includes('private-marker'));}
  finally{process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=fixture.path;}
  writeFileSync(invalid,JSON.stringify({version:1,prewarm:syntheticDiagnosticScope.prewarm}));
  process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=invalid;
  try{assert.equal(diagnosticExampleSchema.safeParse(diagnostic).success,false);assert.equal(prewarmSchema.safeParse(prewarm).success,true);}
  finally{process.env.FIGMA_LOCAL_DIAGNOSTIC_SCOPE_FILE=fixture.path;}
});
test('config rejects unknown keys, duplicate roots and unbounded root lists',()=>{
  assert.equal(diagnosticScopeConfigSchema.safeParse({...syntheticDiagnosticScope,allowAll:true}).success,false);
  for(const nodeIds of [[],['200:2','200:2'],Array.from({length:17},(_,i)=>'200:'+i)])assert.equal(diagnosticScopeConfigSchema.safeParse({...syntheticDiagnosticScope,diagnosticExample:{...syntheticDiagnosticScope.diagnosticExample,nodeIds}}).success,false);
  assert.equal(diagnosticScopeConfigSchema.safeParse({version:1}).success,false);
});
test('tool arguments cannot redirect the host configuration',()=>{
  assert.equal(prewarmSchema.safeParse({...prewarm,configPath:fixture.path}).success,false);
  assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,configPath:fixture.path}).success,false);
  assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,diagnosticParentNodeId:'200:99'}).success,false);
});
test('verified PNG requirements are unchanged',()=>{
  assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,includePng:true}).success,false);
  assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,verificationId:'diag-check-test'}).success,false);
  assert.equal(diagnosticExampleSchema.safeParse({...diagnostic,verificationId:'diag-check-test',requireExistingSnapshot:true,includePng:true,screenshotScale:1}).success,true);
});
