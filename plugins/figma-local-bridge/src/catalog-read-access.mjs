/** Self-contained scope checks serialized only into catalog read operations. */
export function createCatalogReadAccess(figma, access) {
  function assertFile(fileKey, duringRead = false) {
    if (typeof figma.fileKey === 'string' && figma.fileKey !== fileKey) {
      throw new Error(duringRead ? 'Целевой файл изменился во время чтения' : 'Неверный целевой файл');
    }
  }

  async function scope(input, requireRoot = false) {
    const diagnostics = access.diagnostics;
    assertFile(input.fileKey);
    diagnostics.mark('pageLookup');
    const page = await access.node(input.pageId);
    if (page.type !== 'PAGE' || !figma.root.children.includes(page)) {
      throw new Error('pageId должен указывать на страницу целевого файла');
    }
    diagnostics.mark('pageLoad');
    await access.read(page.loadAsync(), 'страница ' + page.id);
    diagnostics.mark('rootLookup');
    const root = input.nodeId || requireRoot ? await access.node(input.nodeId) : page;
    let ancestor = root;
    while (ancestor && ancestor !== page) ancestor = ancestor.parent;
    if (ancestor !== page) throw new Error('nodeId находится вне pageId');
    return {page, root};
  }

  return {assertFile, scope};
}
