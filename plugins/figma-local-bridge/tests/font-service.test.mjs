import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontService } from '../src/font-service.mjs';
import { buildPatchCode } from '../src/figma-code.mjs';
import { buildMoveCode } from '../src/scene-operations.mjs';
import { buildReconstructionRead, recreateScreen } from '../src/reconstruction.mjs';
import { createFigmaMock } from './helpers/figma-mock.mjs';

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

function runGenerated(figma, code, timers) {
  return new AsyncFunction('figma', 'setTimeout', 'clearTimeout', code)(figma,
    (fn, ms) => {
      const timer = setTimeout(fn, ms === 8000 ? 5 : ms);
      timers.add(timer);
      return timer;
    }, timer => { timers.delete(timer); clearTimeout(timer); });
}

for (const operation of ['patch', 'move', 'reconstruction']) test(`${operation}: зависший исходный шрифт не удерживает операцию и не допускает позднюю запись`, async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME', { layoutMode: 'NONE' });
  const node = mock.make('TEXT', { characters: 'Исходный текст', fontName: { family: 'Factor IO', style: 'Bold' } }, root);
  const destination = mock.make('FRAME', { layoutMode: 'NONE' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.figma.loadFontAsync = () => gate;
  const timers = new Set();
  const count = mock.nodes.size;
  mock.writes.length = 0;
  const code = operation === 'patch'
    ? buildPatchCode({ patches: [{ id: node.id, set: { content: 'Изменённый текст' } }], ignoreMissing: false })
    : operation === 'move'
      ? buildMoveCode({ moves: [{ id: node.id, parentId: destination.id }] })
      : buildReconstructionRead(root.id);
  const pending = runGenerated(mock.figma, code, timers);
  let watchdog;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Операция продолжает ждать зависший шрифт')), 500);
    })]), error => {
      assert.equal(error.code, 'FONT_SERVICE_TIMEOUT');
      assert.equal(error.operationStatus, 'not_applied');
      assert.equal(error.retryPolicy, 'after_state_change');
      assert.match(error.nextStep, /get_status/);
      assert.match(error.nextStep, /отдельное открытое окно/);
      assert.match(error.nextStep, /той же реальной спецификацией/);
      assert.match(error.nextStep, /не гарантия для всех версий/);
      assert.match(error.nextStep, /не переключайте вкладку/);
      assert.doesNotMatch(error.nextStep, /активируйте её/);
      assert.match(error.message, /Factor IO.*Bold/);
      assert.match(error.nextStep, /не повторяйте неизменённый запрос/i);
      return true;
    });
    assert.equal(timers.size, 0, 'служба очищает свой таймер при завершении');
    assert.equal(mock.writes.length, 0);
    assert.equal(node.parent, root);
    assert.equal(node.characters, 'Исходный текст');
  } finally {
    clearTimeout(watchdog);
    release();
    await pending.catch(() => {});
    for (const timer of timers) clearTimeout(timer);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.nodes.size, count);
  assert.equal(mock.writes.length, 0, 'поздняя загрузка меняет только кэш шрифтов');
  assert.equal(node.parent, root);
  assert.equal(node.characters, 'Исходный текст');
});

test('recreate_screen прекращает сценарий на зависшем шрифте исходника, не отправляя сборку', async () => {
  const mock = createFigmaMock();
  const root = mock.make('FRAME', { layoutMode: 'NONE' });
  mock.make('TEXT', {}, root);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  mock.figma.loadFontAsync = () => gate;
  const timers = new Set();
  let executions = 0;
  const bridge = {
    runInFile: async (_key, run) => run({ fileKey: 'guide' }),
    execute: async code => { executions++; return { result: await runGenerated(mock.figma, code, timers) }; },
    captureScreenshot: async () => assert.fail('Не должно быть экспорта после неуспешного чтения'),
  };
  const pending = recreateScreen(bridge, { fileKey: 'guide', sourceId: root.id });
  let watchdog;
  try {
    const result = await Promise.race([pending, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Воссоздание продолжает ждать зависший шрифт')), 500);
    })]);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'FONT_SERVICE_TIMEOUT');
    assert.equal(result.structuredContent.operationStatus, 'not_applied');
    assert.equal(executions, 1);
  } finally {
    clearTimeout(watchdog);
    release();
    await pending;
    for (const timer of timers) clearTimeout(timer);
  }
});

test('обычная ошибка службы сохраняет исходную причину; успешный ответ возвращается без подмены', async () => {
  const service = createFontService();
  const font = { family: 'Factor IO', style: 'Bold' };
  const error = new Error('Native Figma error');
  await assert.rejects(service.wait(Promise.reject(error), font, 'загрузка'), failure => failure === error);
  assert.equal(await service.wait(Promise.resolve(font), font, 'загрузка'), font);
});
