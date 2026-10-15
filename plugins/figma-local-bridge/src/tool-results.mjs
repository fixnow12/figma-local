import { errorDetails } from './bridge-errors.mjs';
import { createOperationTimings } from './operation-timings.mjs';

export function toolSuccess(payload, image, timing) {
  if (timing) payload.timings = timing.snapshot();
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      ...(image ? [{ type: "image", data: image.base64, mimeType: "image/png" }] : []),
    ],
    structuredContent: payload,
  };
}

function validationMessage(issues) {
  const fields = new Map();
  function visit(issue) {
    if (issue.code === "invalid_union") {
      for (const branch of issue.unionErrors) for (const child of branch.issues) visit(child);
      return;
    }
    const path = issue.path.reduce((text, part) => typeof part === "number"
      ? `${text}[${part}]` : text ? `${text}.${part}` : String(part), "") || "параметры";
    if (!fields.has(path)) fields.set(path, new Set());
    fields.get(path).add(issue.message);
  }
  issues.forEach(visit);
  const lines = [...fields].slice(0, 12).map(([path, messages]) => `${path}: ${[...messages].join("; ")}`);
  if (fields.size > 12) lines.push(`Ещё полей с ошибками: ${fields.size - 12}.`);
  return `Ошибка параметров:\n${lines.join("\n")}`;
}

export function toolFailure(error, timing) {
  const validation = error?.name === "ZodError" && Array.isArray(error.issues);
  const payload = {
    error: validation ? validationMessage(error.issues) : error instanceof Error ? error.message : String(error),
    ...(validation ? {
      operationStatus: 'not_applied',
      code: 'INVALID_ARGUMENTS',
      nextStep: 'Исправьте перечисленные параметры и повторите вызов. Команда не отправлялась в Figma.',
    } : {}),
    ...errorDetails(error),
    ...(timing ? { timings: timing.snapshot() } : {}),
  };
  // Preserve the JSON-first wire contract for existing clients; also expose a
  // plain-text diagnostic to clients/models that hide nested JSON errors.
  const diagnostic = [payload.error, payload.code && `code: ${payload.code}`,
    payload.operationStatus && `operationStatus: ${payload.operationStatus}`,
    payload.nextStep,
    ['unknown', 'partial'].includes(payload.operationStatus) && 'Не повторяйте мутацию. Сохраните ответ и прочитайте состояние затронутых узлов.',
  ].filter(Boolean).join('\n');
  return { isError: true, content: [
    { type: 'text', text: validation ? payload.error : JSON.stringify(payload) },
    ...(!validation ? [{ type: 'text', text: diagnostic }] : []),
  ], structuredContent: payload };
}

// Keep journal metadata construction separate from target/preview execution.
function operationMetadata(input, name, mutating) {
  const operation = { name, mutating };
  if (name === 'assemble_library_template') {
    operation.componentImportKeys = input.mode === 'apply'
      ? [...new Set(input.snapshot?.nodes?.map(node => node.libraryKey).filter(Boolean) || [])]
      : [];
  }
  if (name === 'import_variables') operation.importInput = input;
  else if (['use_component', 'swap_nested_components'].includes(name)) operation.operationInput = input;
  return operation;
}

// The write and its optional preview share the same pinned connection target and queue.
export async function runToolOperation(bridge, input, code, {
  mutating = true, timeout, screenshotRequested = false, screenshotNode, extendPayload, operationName,
} = {}) {
  const timing = createOperationTimings(operationName || 'operation');
  const targetResolved = timing.start('resolveTarget');
  try {
    const response = await bridge.runInFile(input.fileKey, async (target) => {
      targetResolved();
      const payload = await timing.measure('execute', () => bridge.execute(code, { ...target, timeout, operation: operationMetadata(input, operationName, mutating) }));
      payload.operationStatus = mutating ? "applied" : "read";
      if (extendPayload) extendPayload(payload);
      if (!(typeof screenshotRequested === 'function' ? screenshotRequested(payload) : screenshotRequested)) return { payload };
      try {
        const image = await timing.measure('screenshot', () => {
          const nodeId = screenshotNode(payload);
          if (!nodeId) throw new Error("Узел для снимка не найден");
          return bridge.captureScreenshot(nodeId, { ...target, scale: input.screenshotScale ?? 1 });
        });
        const { base64: _base64, ...metadata } = image;
        payload.screenshot = { status: "captured", ...metadata };
        return { payload, image };
      } catch (error) {
        payload.screenshot = { status: "failed", error: error.message };
        payload.warnings = [mutating
          ? "Изменения выполнены, но снимок не получен. Не повторяйте запись: запросите снимок отдельно."
          : "Чтение выполнено, но снимок не получен."];
        return { payload };
      }
    }, { requireExplicitFile: mutating });
    return toolSuccess(response.payload, response.image, timing);
  } catch (error) {
    targetResolved('error');
    return toolFailure(error, timing);
  }
}
