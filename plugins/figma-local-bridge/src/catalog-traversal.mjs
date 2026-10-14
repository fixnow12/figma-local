/** Serialized into typed catalog operations; state lives only in the plugin session. */
export function createCatalogTraversal(figma, access, registry, captureExampleNode) {
  const fail=(message,code='CATALOG_CURSOR_INVALID')=>{const e=new Error(message);e.code=code;throw e;};
  const hash=value=>{let h=2166136261;for(const c of JSON.stringify(value))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h.toString(16);};
  const hashText=(h,text)=>{for(const c of text)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;};
  function scopeContext(page,root){
    const ancestors=[];
    if(root!==page)for(let node=root.parent;node&&node!==page;node=node.parent)ancestors.push([node.id,node.type,node.name,String(node.description??''),node.parent?.id??null]);
    return JSON.stringify(ancestors);
  }
  function snapshotState(input,page,root,kind,resumeOnly=false) {
    if(!registry?.ready)fail('Возобновляемый обход недоступен до готовности documentchange listener','CATALOG_TRAVERSAL_NOT_READY');
    const key=input.traversalId,identity=JSON.stringify([input.fileKey,page.id,root.id,kind==='example'?'example':'page']);
    let state=registry.sessions.get(key);
    if(state&&(state.page!==page||state.root!==root||state.identity!==identity||state.generation!==registry.generation))fail('Курсор устарел: область или документ изменились');
    if(!state){
      const invalidated=registry.invalidated?.get(key);
      if(invalidated||input.cursor||input.requireExistingSnapshot||input.mode==='resources'||resumeOnly){
        const known=invalidated?.identity===identity;
        const e=new Error(known?'Курсор устарел после documentchange; требуется новая попытка страницы':'Курсор потерял сеанс плагина; требуется новый traversalId');
        e.code=known?'CATALOG_TRAVERSAL_INVALIDATED':'CATALOG_CURSOR_INVALID';
        e.catalogSource={fileKey:input.fileKey,pageId:page.id,nodeId:root.id,traversalId:key,cursor:input.cursor??null,sessionId:registry.sessionId??null,currentGeneration:registry.generation,reason:known?'document-change':'snapshot-missing',...(known?{previousGeneration:invalidated.generation,lastInvalidation:invalidated.event}:{})};
        e.retryPolicy='explicit-page-restart';throw e;
      }
    }
    return {key,identity,state};
  }
  function assertResume(input,page,root,kind){return snapshotState(input,page,root,kind,true).state;}
  function prepare(input,page,root,kind) {
    let {key,identity,state}=snapshotState(input,page,root,kind);
    const walking=!!input.cursor?.startsWith('walk:');
    const existed=!!state;
    if(!state){
      if(registry.sessions.size>=16)fail('Лимит снимков достигнут; перезапустите плагин после завершения активных чтений','CATALOG_SNAPSHOT_LIMIT');
      let enabled=true;for(let n=root;n&&n!==page;n=n.parent)if(/deprecated/i.test(String(n.name??'')+' '+String(n.description??'')))enabled=false;
      state={identity,page,root,scopeContext:scopeContext(page,root),generation:registry.generation,frames:[{node:root,index:-1,enabled,childIndex:root.parent?.children?.findIndex(n=>n.id===root.id)??-1}],records:[],nodes:[],exampleHash:hashText(2166136261,'['),byId:new Map(),ids:[],candidates:[],phase:'tree',roleIndex:0,sequence:0,captureVerificationId:input.verificationId??null,nextVerification:0};
    }
    const request=JSON.stringify([kind,input.cursor??null,input.limit??100]);
    if(state.phase==='ready'){if(walking&&input.cursor!==`walk:${key}:${state.sequence}`)fail('Курсор не соответствует сохранённому frontier');return finishPrepared(state,input,page,root,kind);}
    if(state.lastRequest===request)return {progress:state.lastReply};
    if(walking&&input.cursor!==`walk:${key}:${state.sequence}`)fail('Курсор не соответствует сохранённому frontier');
    if(existed&&!walking&&state.phase!=='ready')fail('Курсор не соответствует фазе обхода');
    // Commit only after cancellation and generation checks. Undo transient mutations
    // so a timeout before publishing the reply cannot silently skip any node.
    const before={frames:state.frames.map(f=>({...f})),records:state.records.length,ids:state.ids.length,candidates:state.candidates.length,phase:state.phase,roleIndex:state.roleIndex,exampleHash:state.exampleHash};
    const modified=[];const started=Date.now();let actions=0;
    try {
      while(state.phase!=='ready'&&actions<512&&(actions===0||Date.now()-started<20)) {
        access.check();actions++;
        if(state.phase==='tree'){
          if(!state.frames.length){state.phase='roles';continue;}
          const frame=state.frames.at(-1),node=frame.node;
          if(node.removed)fail('Курсор устарел: узел удалён');
          if(frame.index===-1){
            if(state.byId.has(node.id))fail('Повторный узел или цикл дерева');
            const enabled=frame.enabled&&(node===page||!/deprecated/i.test(String(node.name??'')+' '+String(node.description??'')));
            const children='children'in node?Array.from(node.children):[];
            const rec={node,id:node.id,type:node.type,name:node.name,description:String(node.description??''),children,childIndex:frame.childIndex,enabled,parent:node.parent?.id??null,signal:node.type==='TEXT'||node.type==='INSTANCE',blocks:enabled&&['COMPONENT','COMPONENT_SET'].includes(node.type)?1:0,variants:[],skip:false};
            if(kind==='example'){const signature=[node.id,node.type,node.name,node.parent?.id??null,children.map(child=>child.id),node.type==='TEXT'?node.characters:null];state.exampleHash=hashText(state.exampleHash,(state.records.length?',':'')+JSON.stringify(signature));}
            state.records.push(rec);state.nodes.push(node);state.byId.set(node.id,rec);frame.enabled=enabled;frame.children=children;frame.index=0;
            rec.structureJSON=JSON.stringify([rec.id,rec.type,rec.name,rec.description,rec.parent,children.map(n=>n.id),node.type==='TEXT'?node.characters:null]);
            if(kind==='example')rec.exampleJSON=JSON.stringify(captureExampleNode(figma,node,children,rec.childIndex));
            if(enabled&&['COMPONENT','COMPONENT_SET'].includes(node.type))state.ids.push(node.id);
          }else {
            const children=frame.children;
            if(frame.index<children.length){const childIndex=frame.index++,child=children[childIndex];if(child.parent!==node)fail('Курсор устарел: родитель изменился');state.frames.push({node:child,index:-1,enabled:frame.enabled,childIndex});}
            else {
              const rec=state.byId.get(node.id);state.frames.pop();
              const parent=state.frames.at(-1);
              if(parent){const p=state.byId.get(parent.node.id);modified.push([p,p.signal,p.blocks,p.variants.length]);
                if(!['COMPONENT','COMPONENT_SET'].includes(node.type))p.signal ||= rec.signal;
                if(p.enabled&&parent.node.type!=='INSTANCE'&&!['COMPONENT','COMPONENT_SET'].includes(parent.node.type))p.blocks=Math.min(2,p.blocks+(rec.enabled?rec.blocks:0));
                if(parent.node.type==='COMPONENT_SET'&&node.type==='COMPONENT'&&rec.enabled)p.variants.push(node.id);
              }
            }
          }
        }else if(state.phase==='roles'){
          if(state.roleIndex>=state.records.length){state.phase='ready';continue;}
          const rec=state.records[state.roleIndex++],node=rec.node,parent=state.byId.get(rec.parent);
          const skip=parent?.skip||false;
          // All active component sets are candidates, even inside an example block.
          if(rec.type==='COMPONENT_SET'&&rec.enabled)state.candidates.push({id:rec.id,name:rec.name,type:rec.type,variantIds:rec.variants.sort()});
          let stop=skip||!rec.enabled||['COMPONENT_SET','COMPONENT','INSTANCE'].includes(rec.type);
          if(!skip&&rec.enabled){
            if(['COMPONENT','INSTANCE'].includes(rec.type)&&node===root&&root!==page)state.candidates.push({id:rec.id,name:rec.name,type:rec.type});
            if(['FRAME','GROUP','SECTION'].includes(rec.type)&&(rec.signal||rec.blocks>=2)){state.candidates.push({id:rec.id,name:rec.name,type:rec.type});stop=true;}
          }
          modified.push([rec,rec.signal,rec.blocks,rec.variants.length,rec.skip]);rec.skip=stop;
        }
      }
      access.check();access.catalog.assertFile(input.fileKey,true);
      if(state.generation!==registry.generation)fail('Курсор устарел: документ изменился во время чтения');
    }catch(e){
      for(const [rec,signal,blocks,length,skip] of modified.reverse()){rec.signal=signal;rec.blocks=blocks;rec.variants.length=length;if(skip!==undefined)rec.skip=skip;}
      for(const rec of state.records.slice(before.records))state.byId.delete(rec.node.id);
      state.records.length=before.records;state.nodes.length=before.records;state.ids.length=before.ids;state.candidates.length=before.candidates;
      Object.assign(state,{frames:before.frames,phase:before.phase,roleIndex:before.roleIndex,exampleHash:before.exampleHash});throw e;
    }
    registry.sessions.set(key,state);
    state.actions=actions;
    if(state.phase==='ready'){
      state.ids.sort();state.candidates.sort((a,b)=>a.id.localeCompare(b.id));
      state.exampleFingerprint=hashText(state.exampleHash,']').toString(16);
      state.manifestFingerprint=hash(state.ids);state.rolesFingerprint=hash({componentIds:state.ids,exampleCandidates:state.candidates});
      return {state};
    }
    state.sequence++;
    const progress={schemaVersion:1,kind,fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,componentIds:[],...(kind==='source-roles'?{exampleCandidates:[],counts:null}:kind==='example'?{nodes:[],gaps:[],screenshotNodeId:null}:{}),complete:false,cursor:input.cursor??null,nextCursor:`walk:${key}:${state.sequence}`,offset:0,total:null,fingerprint:null,coverage:{returned:0,total:null},unreadNodeIds:[],unreadNodeCount:null,unreadNodeIdsComplete:false,traversal:{id:key,sessionId:registry.sessionId??null,generation:state.generation,phase:state.phase,visitedNodes:state.records.length,actions,complete:false,...(state.captureVerificationId?{verificationId:state.captureVerificationId,verified:false,verifiedNodes:0}:{})}};
    state.lastRequest=request;state.lastReply=progress;
    access.diagnostics.count({treeNodesVisited:state.records.length,traversalActions:actions});
    return {progress};
  }

  function changed(node){const e=new Error('Исходник изменился до доставки documentchange: '+node.id);e.code='CATALOG_SNAPSHOT_CHANGED';e.catalogSource={fileKey:figma.fileKey,nodeId:node.id,field:'snapshot',reason:'fresh-values-differ'};throw e;}
  function readRecord(state,rec){
    const node=rec.node;if(node.removed)changed(node);
    if(node===state.root&&(scopeContext(state.page,node)!==state.scopeContext||(node.parent?.children?.findIndex(child=>child.id===node.id)??-1)!==rec.childIndex))changed(node);
    const children='children'in node?node.children:[];
    const current=JSON.stringify([node.id,node.type,node.name,String(node.description??''),node.parent?.id??null,children.map(n=>n.id),node.type==='TEXT'?node.characters:null]);
    if(current!==rec.structureJSON)changed(node);
    if(rec.exampleJSON!==undefined){const data=captureExampleNode(figma,node,children,rec.childIndex);if(JSON.stringify(data)!==rec.exampleJSON)changed(node);return data;}
  }
  function progressReply(state,input,page,root,kind,nextCursor,actions,verification){
    return {schemaVersion:1,kind,fileKey:input.fileKey,pageId:page.id,rootNodeId:root.id,componentIds:[],...(kind==='source-roles'?{exampleCandidates:[],counts:null}:kind==='example'?{nodes:[],gaps:[],screenshotNodeId:null}:{}),complete:false,cursor:input.cursor??null,nextCursor,offset:0,total:null,fingerprint:null,coverage:{returned:0,total:null},unreadNodeIds:[],unreadNodeCount:null,unreadNodeIdsComplete:false,traversal:{id:input.traversalId,sessionId:registry.sessionId??null,generation:state.generation,phase:'verification',visitedNodes:state.records.length,actions,complete:false,verificationId:verification.id,verified:false,verifiedNodes:verification.index}};
  }
  function finishPrepared(state,input,page,root,kind){
    const requires=input.mode!=='resources'&&(input.requireExistingSnapshot||input.verificationId);
    if(!requires)return {state};
    if(input.verificationId&&state.captureVerificationId===input.verificationId)return {state};
    const parsed=input.cursor?.startsWith('verify:')?input.cursor.split(':'):null;
    let v=state.verification;
    let token=input.verificationId??parsed?.[1]??(input.cursor&&v?.kind===kind?v.id:undefined);
    const request=JSON.stringify([kind,input.cursor??null,input.limit??100]);
    if(!token){
      if(v&&!v.complete&&v.kind===kind&&v.lastRequest===request)return {progress:v.lastReply};
      token='check-'+(++state.nextVerification);
    }
    if(v?.id!==token){if(input.cursor)fail('Курсор проверки не соответствует снимку');v={id:token,kind,generation:state.generation,index:0,sequence:0,complete:false};state.verification=v;}
    if(v.kind!==kind||v.generation!==registry.generation)fail('Курсор проверки устарел');
    if(v.lastRequest===request&&v.lastReply)return {progress:v.lastReply};
    if(parsed&&input.cursor!==`verify:${token}:${v.sequence}`)fail('Курсор проверки не соответствует frontier');
    if(v.complete)return {state};
    if(input.cursor&&!parsed)fail('Курсор данных до завершения проверки');
    const started=Date.now();let index=v.index,actions=0;
    while(index<state.records.length&&actions<512&&(actions===0||Date.now()-started<20)){
      access.check();readRecord(state,state.records[index]);index++;actions++;
    }
    assertCurrent(state);access.catalog.assertFile(input.fileKey,true);
    v.index=index;v.actions=actions;state.actions=actions;
    if(index===state.records.length){v.complete=true;return {state};}
    v.sequence++;
    const row=progressReply(state,input,page,root,kind,`verify:${token}:${v.sequence}`,actions,v);v.lastRequest=request;v.lastReply=row;return {progress:row};
  }
  function metadata(state,input){
    const v=state.verification,requested=input.mode!=='resources'&&(input.requireExistingSnapshot||input.verificationId);
    const captured=requested&&input.verificationId&&state.captureVerificationId===input.verificationId;
    const verified=!!(captured||requested&&v?.complete&&(!input.verificationId||v.id===input.verificationId));
    return {id:input.traversalId,sessionId:registry.sessionId??null,generation:state.generation,phase:'ready',visitedNodes:state.records.length,actions:state.actions??0,complete:true,...(verified?{verificationId:captured?state.captureVerificationId:v.id,verified:true,verifiedNodes:state.records.length}:{})};
  }
  function assertCurrent(state){access.check();if(!registry?.ready||state.generation!==registry.generation)fail('Курсор устарел: документ изменился');}
  function readExampleNode(state,node){assertCurrent(state);const rec=state.byId.get(node.id);if(!rec||rec.exampleJSON===undefined)fail('Нет сохранённого payload узла');return readRecord(state,rec);}
  function recordProvenance(state,node,value){const rec=state.byId.get(node.id);if(value===undefined)return;const encoded=JSON.stringify(value);if(rec.mainComponentJSON!==undefined&&rec.mainComponentJSON!==encoded)changed(node);rec.mainComponentJSON=encoded;}
  function release(input,pageId){for(const id of input.releaseTraversalIds??[]){const saved=registry.sessions.get(id);if(saved){const scope=JSON.parse(saved.identity);if(scope[0]!==input.fileKey||saved.phase!=='ready')fail('Освобождение незавершённого снимка или другого файла');}}for(const id of input.releaseTraversalIds??[])registry.sessions.delete(id);}
  return {prepare,assertResume,metadata,assertCurrent,readExampleNode,recordProvenance,release};
}
