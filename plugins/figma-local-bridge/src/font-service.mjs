// Serialized into generated Plugin API code; keep this factory self-contained.
export function createFontService() {
  async function wait(promise, font, stage) {
    // Font loading/listing only affects Figma's font cache. Abandoning this await
    // cannot mutate a node later; never apply this race to a canvas write.
    let timer;
    try {
      const result = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Служба шрифтов Figma не ответила за 8 секунд: " + stage + " «" + font.family + " / " + font.style + "». Отсутствие шрифта не подтверждено.");
          error.code = "FONT_SERVICE_TIMEOUT";
          error.operationStatus = "not_applied";
          error.retryPolicy = "after_state_change";
          error.blockers = [{ type: "font", family: font.family, style: font.style, stage }];
          error.nextStep = "Не повторяйте неизменённый запрос после sleep: состояние Figma не изменилось. Сохраните fileKey, семейство, начертание, этап и результат get_status(fileKey): подключение Bridge, ответ Plugin API и ответ службы шрифтов проверяются отдельно. Для фоновой работы до следующей попытки вынесите целевой файл в отдельное открытое окно Figma Desktop (Move to New Window / Move to Another Window → New Window), не сворачивайте его, оставьте Bridge запущенным и вернитесь к другому рабочему окну. Во время проверки не переключайте вкладку и не прогревайте шрифт. После подтверждённого изменения условий повторите один раз render_screen с dryRun:true и той же реальной спецификацией. Отдельное окно — успешно проверенная конфигурация в двух новых файлах и вероятный обход проблемы скрытой вкладки, не гарантия для всех версий Figma. Если сбой сохраняется, проверьте доступность точного семейства/начертания и службу шрифтов; сохраните блокер без цикла повторов. isActive не доказывает видимость окна или причину тайм-аута. Не подменяйте шрифт.";
          reject(error);
        }, 8000);
      })]);
      return result;
    } finally { clearTimeout(timer); }
  }
  return { wait };
}
