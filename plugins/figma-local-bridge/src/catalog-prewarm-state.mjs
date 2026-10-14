/** Serialized diagnostic only. No catalog snapshot or evidence is created. */
export function createPrewarmTraversal(figma,access,registry,capture,nativeRegistry){
 const known=['4158:42967','4164:43699'];
 const fail=(message,code='PREWARM_INVALIDATED')=>{if(registry)registry.failure={code,message};if(registry?.state)registry.state.failure={code,message};const e=new Error(message);e.code=code;e.diagnosticOnly=true;e.catalogEligible=false;if(registry?.state){if(!registry.state.terminalEvent)registry.state.terminalEvent=sourceTerminal(registry.state,message);e.prewarmDiagnostic=summary(registry.state,[],false);e.catalogSource={fileKey:registry.state.fileKey,pageId:registry.state.page.id,prewarmId:registry.state.id,sessionId:registry.state.sessionId,prewarm:e.prewarmDiagnostic};}throw e;};
 const budget=s=>{access.check();if(s.failure)fail(s.failure.message,s.failure.code);if(Date.now()-s.startedAt>=300000||s.nodes>200000||s.actions>=2000000||s.chunks>10000)fail('Prewarm lifetime budget exceeded','PREWARM_BUDGET_EXCEEDED');};
 const action=s=>{budget(s);s.actions++;};
 const structure=n=>{if(n.removed)fail('Node removed');const children='children'in n?Array.from(n.children):[];if(children.length>200000)fail('Children budget','PREWARM_BUDGET_EXCEEDED');const value=JSON.stringify([n.id,n.type,n.name,String(n.description??''),n.parent?.id??null,children.map(c=>c.id),n.type==='TEXT'?n.characters:null]);if(value.length*3>4194304)fail('Structure payload budget','PREWARM_BUDGET_EXCEEDED');return{children,value};};
 function summary(s,nodeIds,complete){const result={schemaVersion:1,kind:'diagnostic-prewarm',diagnosticOnly:true,catalogEligible:false,catalogFull:false,fileKey:s.fileKey,pageId:s.page.id,prewarmId:s.id,sessionId:s.sessionId,complete,verifiedStructure:complete,topologyVerified:complete,phase:s.phase,nextCursor:complete?null:`prewarm:${s.id}:${s.sequence}`,nodeIds,firstGetterAccesses:s.chunkAccesses??[],mainComponentAccesses:s.chunkMainAccesses??[],counters:{nodes:s.nodes,actions:s.actions,listenerActions:s.listenerActions,captureAndVerifyActions:s.actions-s.listenerActions,chunks:s.chunks,elapsedMs:Date.now()-s.startedAt,gaps:s.gaps,missingMainComponents:s.missingMainComponents,verifiedNodes:s.verifyIndex},journalComplete:s.journalComplete!==false,terminalEvent:s.terminalEvent??null,journalFrom:s.journalPublished??0,journalTotal:s.journal.length,journal:s.journal.slice(s.journalPublished??0).map(e=>({...e})),knownFrames:known.map(id=>s.known[id]?{...s.known[id]}:{id,missing:complete,firstAccessAt:null,firstHeight:null,endHeight:null}),load:s.load,getterGapsScope:'current-chunk',getterCoverageComplete:s.gaps===0,getterGaps:s.chunkGetterGaps??[],failure:s.failure??null,resourceCoverage:'not-prewarmed',captureLimits:{serializedPayloadAdmissionBytes:4194304,synchronousCapturePreemptible:false,hardPeakMemoryCap:false}};if(JSON.stringify(result).length*3>4194304){s.failure={code:'PREWARM_BUDGET_EXCEEDED',message:'Serialized diagnostic response budget exceeded'};return{schemaVersion:1,kind:'diagnostic-prewarm',diagnosticOnly:true,catalogEligible:false,catalogFull:false,complete:false,topologyVerified:false,prewarmId:s.id,fileKey:s.fileKey,pageId:s.page.id,counters:result.counters,journalFrom:s.journalPublished??0,journalTotal:s.journal.length,journal:[],journalComplete:false,terminalEvent:s.terminalEvent??{kind:"diagnostic-overflow",type:null,properties:null,id:null,nodeId:null,nodeIdSourceComplete:false,nodeType:null,fileKey:s.fileKey,pageId:s.page.id,ancestry:[],decision:"reject",reason:"response-overflow"},getterGaps:[],getterGapsComplete:false,failure:s.failure};}return result;}
 function eventRecord(s,change,kind='documentchange'){
  const r={kind,at:Date.now(),type:null,properties:null,id:null,nodeId:null,nodeIdSourceComplete:false,nodeType:null,fileKey:null,pageId:null,ancestry:[],ancestrySteps:0,ancestryDisplayComplete:true,ancestryProofComplete:false,typeSourceComplete:true,idSourceComplete:true,fileKeySourceComplete:true,propertiesSourceComplete:true,fieldErrors:[],decision:'reject',reason:'unclassified',observationalOnly:true};
  const read=(object,key,label=key)=>{try{return object?.[key];}catch(e){r.fieldErrors.push({field:label,message:String(e.message||e).slice(0,160)});return undefined;}};
  const str=(value,key,max=160)=>{if(typeof value==='string'){if(value.length>max){r[key+'SourceComplete']=false;return value.slice(0,max);}return value;}r[key+'SourceComplete']=false;return null;};
  r.type=str(read(change,'type'),'type');r.id=str(read(change,'id'),'id');r.fileKey=str(read(figma,'fileKey'),'fileKey');
  const props=read(change,'properties');if(Array.isArray(props)){r.propertiesTotal=props.length;r.properties=[];if(props.length>32)r.propertiesSourceComplete=false;for(let i=0;i<Math.min(props.length,32);i++){const p=read(props,i);if(typeof p==='string'){r.properties.push(p.slice(0,160));if(p.length>160)r.propertiesSourceComplete=false;}else if(p===null||typeof p==='number'||typeof p==='boolean')r.properties.push(p);else{r.properties.push(null);r.propertiesSourceComplete=false;}}}else{r.propertiesSourceComplete=false;r.propertiesTotal=null;}
  const earlyNode=read(change,'node','change.node');if(earlyNode){const t=read(earlyNode,'type','node.type');r.nodeType=typeof t==='string'?t.slice(0,80):null;}Object.defineProperty(r,'nodePointer',{value:earlyNode});return r;
 }
 function sourceTerminal(s,message){const r=eventRecord(s,null,'source-error');r.reason=String(message).slice(0,160);r.sourceNodeContext=true;r.propertiesSourceComplete=false;r.typeSourceComplete=false;try{r.id=typeof s.lastNode?.id==='string'?s.lastNode.id.slice(0,160):null;r.nodeType=typeof s.lastNode?.type==='string'?s.lastNode.type.slice(0,80):null;r.pageId=s.page.id;}catch(e){r.fieldErrors.push({field:'source-node',message:String(e.message||e).slice(0,160)});}return r;}
 function installObserver(s){registry.observe=event=>{
  if(s.phase==='done'||s.failure)return;
  const started=Date.now();let actions=0,current=null,changes=null,index=0;
  const reject=reason=>{const e=new Error(reason);e.reason=reason;throw e;};
  const step=()=>{if(++actions>512||Date.now()-started>=20)reject('event-cooperative-budget');s.listenerActions++;if(++s.actions>=2000000||Date.now()-s.startedAt>=300000)reject('event-lifetime-budget');};
  const field=(node,key,label)=>{try{return node[key];}catch(e){current.fieldErrors.push({field:label,message:String(e.message||e).slice(0,160)});reject('getter-error:'+label);}};
  const retain=record=>{current=record;if(s.journal.length>=1024){s.journalComplete=false;s.terminalEvent=record;reject('journal-overflow');}s.journal.push(record);};
  try{
   try{changes=event.documentChanges;}catch(e){s.journalComplete=false;retain(eventRecord(s,null));current.fieldErrors.push({field:'documentChanges',message:String(e.message||e).slice(0,160)});reject('getter-error:documentChanges');}
   if(!Array.isArray(changes)||!changes.length){retain(eventRecord(s,null));reject('malformed-or-empty-documentChanges');}
   for(index=0;index<changes.length;index++){
    // Reserve the bounded diagnostic record BEFORE classification/budget rejection.
    // No ancestry traversal or node payload access occurs outside step gates.
    current=eventRecord(s,null);const overflow=s.journal.length>=1024;if(overflow){s.journalComplete=false;s.terminalEvent=current;}else s.journal.push(current);
    let change;try{change=changes[index];}catch(e){current.fieldErrors.push({field:'documentChanges.index',message:String(e.message||e).slice(0,160)});reject('getter-error:documentChanges.index');}
    const metadata=eventRecord(s,change);Object.assign(current,metadata);if(overflow)reject('journal-overflow');step();
    let node=metadata.nodePointer??s.byId.get(current.id)?.node;
    if(current.fieldErrors.length)reject('getter-error:'+current.fieldErrors[0].field);
    if(!node)reject('unresolved-node');
    const id=field(node,'id','node.id');current.nodeId=typeof id==='string'?id.slice(0,160):null;current.nodeIdSourceComplete=typeof id==='string'&&id.length<=160;const type=field(node,'type','node.type');current.nodeType=typeof type==='string'?type.slice(0,80):null;
    if(!current.idSourceComplete||id!==current.id)reject('node-identity-mismatch');const recorded=s.byId.get(id);current.nodeRecorded=!!recorded;current.nodeObjectIdentityVerified=recorded?recorded.node===node:null;if(recorded&&recorded.node!==node)reject('node-object-replaced');
    const types=['FRAME','GROUP','SECTION','TEXT','RECTANGLE','ELLIPSE','LINE','VECTOR','POLYGON','STAR','BOOLEAN_OPERATION','COMPONENT','COMPONENT_SET','INSTANCE'];
    if(!types.includes(type))reject('unsupported-node-type');
    let ancestor=node,depth=0;const seen=new Set();
    while(ancestor!==s.page){
     if(!ancestor||seen.has(ancestor)||depth>=128)reject('unresolved-or-cyclic-ancestry');step();
     const ancestorId=field(ancestor,'id','ancestry.id'),ancestorType=field(ancestor,'type','ancestry.type');
     if(typeof ancestorId!=='string'||ancestorId.length>160||typeof ancestorType!=='string'||ancestorType.length>80)reject('unknown-ancestry-identity');
     if(ancestorType==='PAGE'){current.pageId=ancestorId;reject('foreign-page-scope');}
     if(field(ancestor,'removed','ancestry.removed'))reject('removed-ancestry');
     seen.add(ancestor);depth++;current.ancestrySteps=depth;if(current.ancestry.length<8)current.ancestry.push({id:ancestorId,type:ancestorType});else current.ancestryDisplayComplete=false;
     ancestor=field(ancestor,'parent','ancestry.parent');
    }
    current.pageId=field(s.page,'id','page.id');
    if(!current.fileKeySourceComplete||current.fileKey!==s.fileKey||figma.root.children.length>512||!figma.root.children.includes(s.page))reject('lost-exact-file-page-scope');
    current.ancestryProofComplete=true;
    if(!current.typeSourceComplete||current.type!=='PROPERTY_CHANGE')reject(['CREATE','DELETE'].includes(current.type)?'structural-event-type':'unsupported-event-type');
    if(!current.propertiesSourceComplete||!current.properties?.length||current.properties.some(p=>typeof p!=='string'))reject('malformed-or-incomplete-properties');
    if(current.properties.some(p=>['parent','children','order','id','type'].includes(p)))reject('structural-property');
    if(current.properties.some(p=>!['x','y','width','height','rotation'].includes(p)))reject('unsupported-property');
    current.decision='observe';current.reason='supported-geometry-exact-page';
   }
  }catch(e){
   if(!current){current=eventRecord(s,null);if(s.journal.length<1024)s.journal.push(current);else s.journalComplete=false;}
   current.decision='reject';current.reason=String(e.reason||e.message||e).slice(0,160);s.terminalEvent=current;
   if(Array.isArray(changes)&&index+1<changes.length){s.journalComplete=false;current.unprocessedChanges=changes.length-index-1;}
   s.failure={code:'PREWARM_EVENT_INVALIDATED',message:current.reason};
  }
 };}
 async function run(input){
  if(!nativeRegistry?.ready||!nativeRegistry.sessions||nativeRegistry.sessions.size)fail('Active or unavailable catalog snapshot registry','PREWARM_CATALOG_ACTIVE');
  if(!registry?.ready)fail('Prewarm listener unavailable','PREWARM_NOT_READY');
  let s=registry.state;if(registry.failure)fail(registry.failure.message,registry.failure.code);
  try{
   access.check();if(figma.fileKey!==input.fileKey)fail('Foreign file');
   if(s){if(s.failure)fail(s.failure.message,s.failure.code);if(s.id!==input.prewarmId||s.sessionId!==registry.sessionId||input.cursor!==`prewarm:${s.id}:${s.sequence}`||s.phase==='done')fail('Stale prewarm cursor');if(!figma.root.children.includes(s.page)||await access.node(input.pageId)!==s.page)fail('Exact page/root replaced');}
   else{if(registry.used||input.cursor)fail('Lost prewarm session');registry.used=true;const page=await access.node(input.pageId);if(!page||page.type!=='PAGE'||!figma.root.children.includes(page))fail('Missing exact page');s={id:input.prewarmId,fileKey:input.fileKey,sessionId:registry.sessionId,page,startedAt:Date.now(),phase:'capture',frames:[{node:page,index:-1,childIndex:-1}],records:[],byId:new Map(),nodes:0,actions:0,chunks:0,listenerActions:0,sequence:0,verifyIndex:0,endIndex:0,gaps:0,missingMainComponents:0,journal:[],journalPublished:0,journalComplete:true,terminalEvent:null,known:{},load:{startAt:Date.now(),endAt:null}};registry.state=s;installObserver(s);await access.read(page.loadAsync(),'prewarm initial page load');s.load.endAt=Date.now();}
   budget(s);s.chunks++;if(s.chunks>10000)fail('Chunk budget','PREWARM_BUDGET_EXCEEDED');const started=Date.now(),beforeActions=s.actions,nodeIds=[];s.chunkAccesses=[];s.chunkMainAccesses=[];s.chunkGetterGaps=[];
   while(s.phase!=='done'&&s.actions-beforeActions<512&&(s.actions===beforeActions||Date.now()-started<20)){
    action(s);if(s.phase==='capture'){
     if(!s.frames.length){s.phase='verify';continue;}
     const f=s.frames.at(-1),n=f.node;s.lastNode=n;
     if(f.index===-1){if(s.nodes>=200000)fail('Node budget','PREWARM_BUDGET_EXCEEDED');if(s.byId.has(n.id))fail('Duplicate or cycle');const shape=structure(n),at=Date.now();if(n!==s.page&&n.parent!==f.parent)fail('Parent changed');const rec={node:n,parentObject:n.parent,childObjects:shape.children,structure:shape.value};s.records.push(rec);s.byId.set(n.id,rec);s.nodes++;nodeIds.push(n.id);s.chunkAccesses.push({id:n.id,at,phase:'capture',projection:'captureCatalogExampleNode'});access.check();const data=capture(figma,n,shape.children,f.childIndex),serialized=JSON.stringify(data);if(serialized.length*3>4194304)fail('Transient payload budget','PREWARM_BUDGET_EXCEEDED');s.gaps+=data.gaps.length;s.chunkGetterGaps.push(...data.gaps);if(JSON.stringify(s.chunkGetterGaps).length*3>4194304)fail('Gap payload budget','PREWARM_BUDGET_EXCEEDED');if(known.includes(n.id)){const height=data.value.properties.height;s.known[n.id]={id:n.id,type:n.type,pageId:s.page.id,firstAccessAt:at,firstHeight:typeof height==='number'?height:null,heightUnavailable:typeof height!=='number',...(typeof height!=='number'?{heightUnavailableReason:data.gaps.find(g=>g.field==='height')?.message??'height unavailable or non-numeric'}:{}),endHeight:null};if(n.type!=='FRAME')fail('Known frame wrong type');}access.check();budget(s);f.children=shape.children;f.index=n.type==='INSTANCE'?-2:0;}
     else if(f.index===-2){s.chunkMainAccesses.push({id:n.id,at:Date.now(),phase:'capture',getter:'getMainComponentAsync'});access.check();const component=await access.read(n.getMainComponentAsync(),'prewarm main component '+n.id);access.check();if(!component)s.missingMainComponents++;const provenance=JSON.stringify(component?{status:'resolved',id:component.id,key:component.key,name:component.name,remote:component.remote}:{status:'missing'});if(provenance.length*3>4194304)fail('Provenance budget','PREWARM_BUDGET_EXCEEDED');budget(s);f.index=0;}
     else if(f.index<f.children.length){const childIndex=f.index++,child=f.children[childIndex];if(child.parent!==n)fail('Child parent changed');s.frames.push({node:child,parent:n,index:-1,childIndex});}else s.frames.pop();
    }else{
     if(s.verifyIndex<s.records.length){const rec=s.records[s.verifyIndex++];const live=structure(rec.node);if(live.value!==rec.structure||rec.node.parent!==rec.parentObject||live.children.length!==rec.childObjects.length||live.children.some((n,i)=>n!==rec.childObjects[i]))fail('Final structure changed');}
     else if(s.endIndex<known.length){const id=known[s.endIndex++],observation=s.known[id];if(observation){const n=s.byId.get(id).node;observation.endAccessAt=Date.now();let height;try{height=n.height;}catch(e){observation.endHeightUnavailable=true;observation.endHeightError=String(e.message||e);s.gaps++;s.chunkGetterGaps.push({nodeId:id,field:'height',reason:'property-unavailable',message:observation.endHeightError});}observation.endHeight=typeof height==='number'?height:null;observation.endHeightUnavailable=typeof height!=='number';}budget(s);}else{budget(s);s.phase='done';}
    }
   }
   budget(s);if(nativeRegistry.sessions.size)fail('Catalog snapshot appeared during prewarm','PREWARM_CATALOG_ACTIVE');s.sequence++;const result=summary(s,nodeIds,s.phase==='done');if(s.failure)fail(s.failure.message,s.failure.code);s.journalPublished=s.journal.length;return result;
  }catch(e){if(s&&!s.failure)s.failure={code:e.code??'PREWARM_SOURCE_ERROR',message:String(e.message||e)};if(s&&!s.terminalEvent)s.terminalEvent=sourceTerminal(s,e.message||e);if(!e.prewarmDiagnostic&&s)e.prewarmDiagnostic=summary(s,[],false);if(s)e.catalogSource={fileKey:s.fileKey,pageId:s.page.id,prewarmId:s.id,sessionId:s.sessionId,prewarm:e.prewarmDiagnostic};registry.failure=s?.failure??{code:e.code??'PREWARM_SOURCE_ERROR',message:String(e.message||e)};throw e;}
 }
 return{run};
}
