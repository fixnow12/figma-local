// Serialized into generated Plugin API code; keep this factory self-contained.
export function createFontService(control) {
  // Runtime-local pending native requests, not a cache of timeout/rejection results.
  // A Promise.race deadline cannot cancel Figma's native font operation.
  const state = control?.fontService || { pending: new Map(), sequence: 0, recent: [] };
  function check() {
    if (control?.cancelled) {
      const error = new Error("Время операции истекло до изменения макета");
      error.code = "OPERATION_CANCELLED_BEFORE_MUTATION";
      error.operationStatus = "not_applied";
      throw error;
    }
  }
  function describe(row) {
    return { requestId: row.id, kind: row.kind, family: row.font.family, style: row.font.style,
      stage: row.stage, elapsedMs: Math.max(0, Date.now() - row.startedAt), timedOut: row.timedOut };
  }
  function snapshot() {
    return { pendingCount: state.pending.size, pending: [...state.pending.values()].map(describe), recent: state.recent.slice() };
  }
  state.snapshot = snapshot;
  function failure(code, font, stage, row) {
    const error = new Error(code === "FONT_SERVICE_PENDING"
      ? "Предыдущий запрос службы шрифтов Figma ещё не завершён: «" + font.family + " / " + font.style + "». Новый native запрос не отправлен."
      : "Служба шрифтов Figma не ответила за 8 секунд: " + stage + " «" + font.family + " / " + font.style + "». Отсутствие шрифта не подтверждено.");
    error.code = code;
    error.operationStatus = "not_applied";
    error.retryPolicy = "after_state_change";
    error.blockers = [{ type: "font", family: font.family, style: font.style, stage,
      ...(row ? describe(row) : {}), nativeCancellationSupported: false }];
    error.nextStep = "Сохраните fileKey, семейство, начертание, этап и get_status(fileKey). execution.fontService показывает незавершённые native font-запросы отдельно от busy Plugin API; READY не подтверждает шрифты. Тайм-аут не отменяет native загрузку. Не повторяйте неизменённый запрос после sleep и не запускайте второй запрос, пока первый не завершён. Используйте штатное восстановление текущего RUN только после подтверждённого изменения условий и в пределах его бюджета. Для фоновой работы целевой файл должен быть вынесен в отдельное открытое окно Figma Desktop, не свёрнутое; это не гарантия для всех версий Figma. Во время проверки не переключайте вкладку и не прогревайте шрифт. Разрешённая повторная проверка — один render_screen с dryRun:true и той же реальной спецификацией. Если бюджет исчерпан, сохраните блокер; перезапуск Figma требует отдельного разрешения. Не подменяйте шрифт.";
    return error;
  }
  async function wait(promise, font, stage, row) {
    // Only font loading/listing may be detached; never race a canvas mutation.
    let timer;
    try {
      check();
      const result = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (row) row.timedOut = true;
          reject(failure("FONT_SERVICE_TIMEOUT", font, stage, row));
        }, 8000);
      })]);
      check();
      return result;
    } finally { clearTimeout(timer); }
  }
  async function request(kind, font, stage, start) {
    check();
    const key = kind === "list" ? "list" : JSON.stringify(["load", font.family, font.style]);
    let row = state.pending.get(key);
    if (row?.timedOut) throw failure("FONT_SERVICE_PENDING", font, stage, row);
    if (!row) {
      row = { id: ++state.sequence, kind, font: { family: font.family, style: font.style }, stage, startedAt: Date.now(), timedOut: false };
      state.pending.set(key, row);
      function settled(outcome, error) {
        if (state.pending.get(key) === row) state.pending.delete(key);
        state.recent.push({ ...describe(row), outcome, ...(error ? { reason: String(error.message || error).slice(0, 500) } : {}) });
        if (state.recent.length > 8) state.recent.shift();
      }
      // Both settlement handlers are attached before detaching the await, including
      // late rejection. No stale failed Promise survives in the pending registry.
      row.promise = Promise.resolve().then(start).then(value => { settled("fulfilled"); return value; }, error => { settled("rejected", error); throw error; });
    }
    return wait(row.promise, font, stage, row);
  }
  return { wait, snapshot,
    load: (figma, font, stage = "загрузка") => request("load", font, stage, () => { check(); return figma.loadFontAsync(font); }),
    list: (figma, font, stage = "список доступных шрифтов") => request("list", font, stage, () => { check(); return figma.listAvailableFontsAsync(); }) };
}
