import{prewarmSchema}from'../src/catalog-prewarm.mjs';
import {readNodeScopeSchema} from '../src/node-scope.mjs';
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { screenSpecPublicSchema } from "../src/schemas.mjs";
import {catalogPageSchema} from '../src/catalog-read.mjs';
import {readComponentMetadataSchema} from '../src/component-metadata.mjs';
import {diagnosticExampleSchema} from '../src/diagnostic-example.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export function designSchemaText() {
  const schema = zodToJsonSchema(screenSpecPublicSchema, {
    name: "CodexFigmaDesignSpec",
    target: "jsonSchema7",
});
schema.$id = "https://local.invalid/codex-figma-design-spec.schema.json";
schema.title = "Codex Figma design spec";
schema.description = "Плоская типизированная спека экрана для render_screen. Семантические проверки parentKey, циклов и токенов выполняются MCP-сервером.";
return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const typed=(schema,name)=>`${JSON.stringify(zodToJsonSchema(schema,{name,target:'jsonSchema7'}),null,2)}\n`;
  for(const [file,expected] of [
    ['design-spec.schema.json',designSchemaText()],
    ['catalog-page.schema.json',typed(catalogPageSchema,'ScanCatalogPage')],
    ['prewarm.schema.json',typed(prewarmSchema,'PrewarmCatalogPage')],
    ['node-scope.schema.json',typed(readNodeScopeSchema,'ReadNodeScope')],
    ['component-metadata.schema.json',typed(readComponentMetadataSchema,'ReadComponentMetadata')],
    ['diagnostic-example.schema.json',typed(diagnosticExampleSchema,'ReadDiagnosticExample')],
  ]){
    const path=join(root,'schemas',file);
    if(process.argv.includes('--check')){
      if(await readFile(path,'utf8')!==expected)throw Error('JSON Schema устарела: '+file+'. Выполните npm run schema:export.');
    }else await writeFile(path,expected,'utf8');
  }
  if(process.argv.includes('--check'))console.log('JSON Schema соответствует исходникам.');
}
