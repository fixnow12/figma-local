import {z} from 'zod';
import {catalogExampleInputSchema,buildDiagnosticExampleProjectionCode} from './catalog-read.mjs';
import {runToolOperation} from './tool-results.mjs';
import {validateLocalDiagnosticScope,readLocalDiagnosticScope} from './catalog-diagnostic-scope.mjs';

export const diagnosticExampleInputSchema={
  fileKey:z.string().min(1).max(128),pageId:z.string().regex(/^\d+:\d+$/),
  nodeId:z.string().regex(/^\d+:\d+$/),
  traversalId:z.string().regex(/^diag-chat-[a-zA-Z0-9_-]{1,60}$/),
  cursor:catalogExampleInputSchema.cursor,
  verificationId:z.string().regex(/^diag-check-[a-zA-Z0-9_-]{1,60}$/).optional(),
  requireExistingSnapshot:z.boolean().optional(),
  limit:z.number().int().min(1).max(100).optional(),
  includePng:z.boolean().optional(),screenshotScale:z.literal(1).optional(),
};
export const diagnosticExampleSchema=z.object(diagnosticExampleInputSchema).strict().superRefine((value,ctx)=>{
  validateLocalDiagnosticScope('diagnosticExample',value,ctx);
  if(value.includePng&&(!value.requireExistingSnapshot||!value.verificationId))ctx.addIssue({code:'custom',message:'PNG requires existing snapshot and fresh verification ID'});
  if(value.verificationId&&!value.requireExistingSnapshot)ctx.addIssue({code:'custom',message:'Verification requires an existing snapshot'});
});
export const buildDiagnosticExampleCode=input=>{
  const parsed=diagnosticExampleSchema.parse(input),scope=readLocalDiagnosticScope('diagnosticExample');
  if(parsed.fileKey!==scope.fileKey||parsed.pageId!==scope.pageId||!scope.nodeIds.includes(parsed.nodeId))throw Error('Diagnostic scope changed before code generation');
  return buildDiagnosticExampleProjectionCode({...parsed,diagnosticParentNodeId:scope.parentNodeId});
};
export async function runDiagnosticExample(bridge,input){
  const parsed=diagnosticExampleSchema.parse(input);
  return runToolOperation(bridge,parsed,buildDiagnosticExampleCode(parsed),{
    operationName:'read_diagnostic_example',mutating:false,
    screenshotRequested:payload=>Boolean(parsed.includePng&&payload.result?.traversal?.verified&&payload.result?.screenshotNodeId),
    screenshotNode:payload=>payload.result?.screenshotNodeId,
  });
}
