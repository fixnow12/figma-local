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
    const loadRegistry=typeof executionControl!=='undefined'?executionControl.catalogTraversal:undefined;
    const saved=input.traversalId&&loadRegistry?.sessions?.get(input.traversalId);
    const kind=input.mode===undefined?'example':input.mode==='roles'?'source-roles':'manifest';
    let root;
    const requireSaved=!!(input.cursor||input.requireExistingSnapshot||input.verificationId||input.mode==='resources');
    let reuse=false;
    if(input.traversalId&&(saved||requireSaved)){
      diagnostics.mark('rootLookup');
      root=input.nodeId||requireRoot?await access.node(input.nodeId):page;
      let ancestor=root;
      while(ancestor&&ancestor!==page)ancestor=ancestor.parent;
      if(ancestor!==page)throw new Error('nodeId находится вне pageId');
      // Pure native admission: reject lost/stale/foreign cursors before any load.
      access.catalog.traversal.assertResume(input,page,root,kind);
      reuse=true;
    }
    if(reuse){
      // An exact live snapshot owns a loaded PageNode; inaccessible children fail
      // closed rather than silently loading/restarting a potentially changed page.
      if(!Array.isArray(page.children))throw new Error('Snapshot page is not loaded');
    }else{
      const loadMarker={pageId:page.id,startAt:Date.now(),endAt:null};
      if(loadRegistry)loadRegistry.pageLoad=loadMarker;
      try { await access.read(page.loadAsync(), 'страница ' + page.id); }
      finally { loadMarker.endAt=Date.now(); }
      if(loadRegistry?.ready&&input.traversalId&&!saved&&!input.cursor&&!input.requireExistingSnapshot&&!input.verificationId){
        // Observe all document events for a finite pre-snapshot quiet interval.
        // Nothing is exempted: later target/dependency events still invalidate.
        const token=()=>JSON.stringify([loadRegistry.generation,loadRegistry.lastDocumentChange?.at??null]);
        const started=Date.now();let previous=token(),stableSince=started,quiet=false;
        while(Date.now()-started<250){
          await access.read(new Promise(resolve=>setTimeout(resolve,10)),'page layout settling');
          const now=Date.now(),current=token();if(current!==previous){previous=current;stableSince=now;}
          if(now-stableSince>=50){quiet=true;break;}
        }
        loadMarker.settleEndAt=Date.now();loadMarker.settleGeneration=loadRegistry.generation;
        if(!quiet){const error=new Error('Page did not reach bounded pre-snapshot quiet interval');error.code='CATALOG_PAGE_NOT_QUIET';throw error;}
      }
    }
    diagnostics.mark('rootLookup');
    root = root ?? (input.nodeId || requireRoot ? await access.node(input.nodeId) : page);
    let ancestor = root;
    while (ancestor && ancestor !== page) ancestor = ancestor.parent;
    if (ancestor !== page) throw new Error('nodeId находится вне pageId');
    return {page, root};
  }

  return {assertFile, scope};
}
