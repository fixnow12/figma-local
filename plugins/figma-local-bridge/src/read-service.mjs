// Serialized into Plugin API code. Only wrap native read/cache promises here:
// abandoning an await must never allow a delayed setter/import/canvas write.
export function createReadService(figma, check = () => {}) {
  async function wait(promise, resource, timeoutMs = 6000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 6000 || timeoutMs > 20000) throw new Error('Invalid native read timeout');
    let timer;
    try {
      const value = await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Figma не завершила чтение за " + timeoutMs / 1000 + " секунд: " + resource + ". Данные не получены; отсутствие ресурса не подтверждено.");
          error.code = "FIGMA_READ_TIMEOUT";
          error.blockers = [{ type: "read", resource }];
          error.nextStep = "Проверьте get_status с тем же fileKey. Не повторяйте запрос циклом с sleep. Для узла прочитайте меньшую ветку или родительский экземпляр; для библиотеки проверьте доступность ресурса в целевом файле. Тайм-аут чтения не подтверждает сбой другого файла.";
          reject(error);
        }, timeoutMs);
      })]);
      check();
      return value;
    } finally { clearTimeout(timer); }
  }
  async function node(id) {
    check();
    // Synthetic descendant IDs have a concrete owning instance. Walking its
    // already available subtree avoids a native lookup that can stall on these
    // IDs. Match the complete ID; never resolve a child by a suffix or by name.
    const owner = /^I([^;]+);/.exec(id);
    if (owner) {
      const root = await wait(figma.getNodeByIdAsync(owner[1]), "экземпляр " + owner[1]);
      if (root?.type === "INSTANCE" && !root.removed) {
        const queue = [root];
        let count = 0;
        while (queue.length && count++ < 2000) {
          check();
          const current = queue.pop();
          if (current.id === id && !current.removed) return current;
          if ("children" in current) {
            for (const child of current.children) {
              if (child.id === id && !child.removed) return child;
              if (queue.length < 2000) queue.push(child);
            }
          }
        }
      }
    }
    return wait(figma.getNodeByIdAsync(id), "узел " + id);
  }
  return { wait, node };
}
