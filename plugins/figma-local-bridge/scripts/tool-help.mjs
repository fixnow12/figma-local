// Targeted offline help from the same schemas as the server. No config, sockets,
// native imports, font service or Figma access. Full JSON Schema is opt-in.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { parseRenderScreenInput, normalizeScreenSpec, renderScreenInputSchema,
  patchNodesSchema, inspectSelectionSchema, useComponentSchema } from '../src/schemas.mjs';
import { toolFailure } from '../src/tool-results.mjs';

export const helpTools = {
  render_screen: { schema: z.object(renderScreenInputSchema).strict(), parse: input => normalizeScreenSpec(parseRenderScreenInput(input).spec),
    note: 'spec.type=screen только у корня; spec.nodes — плоский массив. parentKey — строка. Offline не проверяет шрифты и Plugin API; затем dryRun:true.',
    example: { fileKey: 'TARGET_FILE', dryRun: true, spec: { key: 'example-screen', name: 'Экран', type: 'screen', width: 390, height: 844, layout: {direction: 'vertical'}, background: '#FFFFFF', nodes: [
      { key: 'title', type: 'text', name: 'Заголовок', content: 'Пример', color: '#202020', fontSize: 24 },
      { key: 'card', type: 'frame', name: 'Карточка', width: 'fill', height: 'hug', layout: {direction: 'vertical'}, background: '#F5F5F5' },
      { key: 'body', parentKey: 'card', type: 'text', name: 'Текст', content: 'Описание', fontSize: 16 },
    ] } } },
  patch_nodes: { schema: patchNodesSchema,
    note: 'key/id адресуют цель; свойства только внутри set. color — TEXT; background — контейнер; fills — типизированный массив Paint. Тип цели читайте через inspect_selection(detail:full).',
    example: {fileKey:'TARGET_FILE', patches:[{key:'title',set:{color:'#202020',fontSize:24}}]} },
  inspect_selection: { schema: inspectSelectionSchema,
    note: 'screenshotScale 0.5–4; cap 1568 может снизить effectiveScale. Каждый экран и спорный CTA читайте отдельно по nodeId; обзор не подтверждает детали.',
    example: {fileKey:'TARGET_FILE',nodeId:'1:2',detail:'full',depth:3,screenshot:true,screenshotScale:1} },
  use_component: { schema: useComponentSchema,
    note: 'Ровно один sourceId/sourceKey/libraryKey. parentKey — строка, parentId — точный ID; dryRun:true не создаёт экземпляр.',
    example: {fileKey:'TARGET_FILE',sourceId:'1:2',parentKey:'card',key:'example-instance',dryRun:true} },
};

export async function main(args = process.argv.slice(2)) {
  const {values,positionals} = parseArgs({args,allowPositionals:true,options:{schema:{type:'boolean'},validate:{type:'string'}}});
  const tool = helpTools[positionals[0]];
  if (!tool || positionals.length !== 1 || (values.schema && values.validate)) throw new Error('Usage: node scripts/tool-help.mjs '+Object.keys(helpTools).join('|')+' [--schema | --validate FILE]');
  if (values.validate) {
    const input = JSON.parse(await readFile(values.validate,'utf8'));
    if (tool.parse) tool.parse(input); else tool.schema.parse(input);
    return {valid:true,scope:'offline_schema',fonts:'not_checked',nativeProperties:'not_checked',visual:'not_checked'};
  }
  if (values.schema) return zodToJsonSchema(tool.schema,{target:'jsonSchema7'});
  return {tool:positionals[0],note:tool.note,example:tool.example,nextStep:'--schema для точной формы; --validate FILE перед записью. Ошибки не исправляются повтором того же вызова.'};
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(),null,2)); }
  catch(error) { console.error(JSON.stringify(toolFailure(error).structuredContent,null,2)); process.exitCode=1; }
}
