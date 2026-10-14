import{z}from'zod';import{compileOperation}from'./scene-access.mjs';import{createPrewarmTraversal}from'./catalog-prewarm-state.mjs';
import {validateLocalDiagnosticScope} from './catalog-diagnostic-scope.mjs';
export const prewarmInputSchema={fileKey:z.string().min(1).max(128),pageId:z.string().regex(/^\d+:\d+$/),prewarmId:z.string().regex(/^cards-prewarm-[a-zA-Z0-9_-]{1,60}$/),cursor:z.string().regex(/^prewarm:cards-prewarm-[a-zA-Z0-9_-]{1,60}:\d+$/).optional()};
export const prewarmSchema=z.object(prewarmInputSchema).strict().superRefine((input,ctx)=>validateLocalDiagnosticScope('prewarm',input,ctx));
async function operation(figma,input,access){return createPrewarmTraversal(figma,access,typeof executionControl!=='undefined'?executionControl.catalogPrewarm:undefined,access.catalog.exampleNode,typeof executionControl!=='undefined'?executionControl.catalogTraversal:undefined).run(input);}
export const buildPrewarmCode=input=>`const createPrewarmTraversal=(${createPrewarmTraversal.toString()});\n`+compileOperation(operation,prewarmSchema.parse(input),{readOnly:true,catalogDiagnostics:true});
