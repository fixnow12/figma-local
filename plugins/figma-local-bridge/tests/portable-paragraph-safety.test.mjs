import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred, turn } from './helpers/plugin-harness.mjs';
import { buildPatchCode } from '../src/figma-code.mjs';
import { applyExactParagraphRanges } from '../src/text-paragraphs.mjs';
import { createFigmaMock } from './helpers/figma-mock.mjs';

const font = { family: 'Factor IO', style: 'Bold' };

function paragraphFixture() {
  const mock = createFigmaMock();
  const node = mock.make('TEXT', { characters: 'Before', fontName: font, paragraphSpacing: 0, paragraphIndent: 0 });
  const events = [];
  const styles = new Map();
  mock.figma.createTextStyle = () => {
    const style = { id: 'style-' + events.length, setBoundVariable() {}, remove() { styles.delete(this.id); events.push('removeStyle'); } };
    styles.set(style.id, style);
    events.push('createTextStyle');
    return style;
  };
  mock.figma.getStyleByIdAsync = async id => styles.get(id) ?? null;
  node.setRangeTextStyleIdAsync = async (start, end, id) => {
    events.push('setRangeTextStyleIdAsync');
    const style = styles.get(id);
    if (style) {
      node.paragraphSpacing = style.paragraphSpacing;
      node.paragraphIndent = style.paragraphIndent;
    } else node.textStyleId = id;
  };
  return { mock, node, events, styles };
}

test('generated paragraph patch does not write after timeout while its tracked font load is pending', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  const gate = deferred();
  let loads = 0;
  mock.figma.loadFontAsync = () => (++loads === 3 ? gate.promise : Promise.resolve());
  const runner = harness(mock.figma);
  const operation = runner.start(buildPatchCode({ patches: [{ id: node.id, set: { textRuns: [{ start: 0, end: 6, paragraphSpacing: 12 }] } }], ignoreMissing: false }), 1000);
  await turn();
  assert.equal(loads, 3);
  await runner.advance(1000);
  assert.equal((await operation.result).code, 'PLUGIN_EXECUTION_TIMEOUT');
  const status = await runner.status();
  assert.equal(status.busy, true);
  const pendingWhileTimedOut = status.fontService.pendingCount;
  gate.resolve();
  await operation.done;
  assert.equal(events.length, 0, 'no forward temporary style creation or range mutation after cancellation');
  assert.equal(pendingWhileTimedOut, 1, 'paragraph font load is tracked until native settlement');
  assert.equal(styles.size, 0);
  assert.equal(node.paragraphSpacing, 0);
  assert.equal((await runner.status()).busy, false);
  assert.equal((await runner.status()).fontService.pendingCount, 0);
  assert.equal(runner.timers.size, 0);
});

test('generated paragraph patch still applies exact range and removes temporary style', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  const runner = harness(mock.figma);
  const operation = runner.start(buildPatchCode({ patches: [{ id: node.id, set: { textRuns: [{ start: 0, end: 6, paragraphSpacing: 12 }] } }], ignoreMissing: false }));
  const result = await operation.result;
  await operation.done;
  assert.equal(result.success, true);
  assert.equal(node.paragraphSpacing, 12);
  assert.deepEqual(events, ['createTextStyle', 'setRangeTextStyleIdAsync', 'removeStyle']);
  assert.equal(styles.size, 0);
  assert.equal((await runner.status()).fontService.pendingCount, 0);
  assert.equal(runner.timers.size, 0);
});

test('forward helper checks cancellation after asynchronous variable lookup', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  const gate = deferred();
  const control = { cancelled: false };
  node.getStyledTextSegments = (_fields, start, end) => [{ start, end, fontName: font, fontSize: 14, paragraphSpacing: 0,
    boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'variable-1' } } }];
  mock.figma.variables.getVariableByIdAsync = () => gate.promise;
  const operation = applyExactParagraphRanges(mock.figma, node, [{ start: 0, end: 6, paragraphSpacing: 12 }], {
    loadFont: async () => {},
    check: () => { if (control.cancelled) throw Error('cancelled'); },
  });
  await turn();
  control.cancelled = true;
  gate.resolve({ id: 'variable-1' });
  await assert.rejects(operation, /cancelled/);
  assert.equal(events.length, 0);
  assert.equal(styles.size, 0);
});

test('in-flight range setter finishes cleanup, then rollback restores paragraph after timeout', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  const gate = deferred();
  const originalSetter = node.setRangeTextStyleIdAsync;
  let firstRange = true;
  node.setRangeTextStyleIdAsync = async (...args) => {
    if (firstRange) {
      firstRange = false;
      await gate.promise;
    }
    return originalSetter(...args);
  };
  const runner = harness(mock.figma);
  const operation = runner.start(buildPatchCode({ patches: [{ id: node.id, set: { textRuns: [{ start: 0, end: 6, paragraphSpacing: 12 }] } }], ignoreMissing: false }), 1000);
  await turn();
  assert.deepEqual(events, ['createTextStyle']);
  await runner.advance(1000);
  assert.equal((await operation.result).code, 'PLUGIN_EXECUTION_TIMEOUT');
  assert.equal((await runner.status()).busy, true);
  gate.resolve();
  await operation.done;
  assert.equal(node.paragraphSpacing, 0);
  assert.equal(styles.size, 0);
  assert.ok(events.includes('removeStyle'));
  assert.equal((await runner.status()).busy, false);
  assert.equal(runner.timers.size, 0);
});

test('in-flight explicit range style cannot lead to paragraph writes after timeout', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  const gate = deferred();
  const originalLookup = mock.figma.getStyleByIdAsync;
  mock.figma.getStyleByIdAsync = id => id === 'base-style'
    ? Promise.resolve({ id, type: 'TEXT', fontName: font })
    : originalLookup(id);
  const originalSetter = node.setRangeTextStyleIdAsync;
  let firstRange = true;
  node.setRangeTextStyleIdAsync = async (...args) => {
    if (firstRange) {
      firstRange = false;
      await gate.promise;
    }
    return originalSetter(...args);
  };
  const runner = harness(mock.figma);
  const operation = runner.start(buildPatchCode({ patches: [{ id: node.id, set: {
    textRuns: [{ start: 0, end: 6, textStyleId: 'base-style', paragraphSpacing: 12 }],
  } }], ignoreMissing: false }), 1000);
  await turn();
  assert.equal(events.length, 0);
  await runner.advance(1000);
  assert.equal((await operation.result).code, 'PLUGIN_EXECUTION_TIMEOUT');
  gate.resolve();
  await operation.done;
  assert.equal(node.paragraphSpacing, 0);
  assert.equal(styles.size, 0);
  assert.ok(!events.includes('createTextStyle'));
  assert.equal((await runner.status()).busy, false);
  assert.equal(runner.timers.size, 0);
});

test('rollback paragraph restore remains available while forward control is cancelled', async () => {
  const { mock, node, events, styles } = paragraphFixture();
  node.paragraphSpacing = 12;
  await applyExactParagraphRanges(mock.figma, node, [{ start: 0, end: 6, paragraphSpacing: 0 }]);
  assert.equal(node.paragraphSpacing, 0);
  assert.deepEqual(events, ['createTextStyle', 'setRangeTextStyleIdAsync', 'removeStyle']);
  assert.equal(styles.size, 0);
});
