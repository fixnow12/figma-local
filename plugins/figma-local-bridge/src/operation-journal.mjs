import {createHash,randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
export const canonical = value => JSON.stringify(sort(value));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export const importArgsHash = input => createHash('sha256').update(canonical({fileKey:input.fileKey,variables:input.variables})).digest('hex');
export const operationArgsHash = input => createHash('sha256').update(canonical({fileKey:input.fileKey,name:input.name,args:input.args})).digest('hex');
const failure=(code,message,extra={})=>Object.assign(Error(message),{code,operationStatus:'not_applied',commandSent:false,...extra});
export class OperationJournal {
 constructor(directory){this.directory=join(directory,'operations');mkdirSync(this.directory,{recursive:true,mode:0o700});this.records=new Map();for(const f of readdirSync(this.directory).filter(f=>/^[a-f0-9-]{36}\.json$/i.test(f))){const r=JSON.parse(readFileSync(join(this.directory,f),'utf8'));this.records.set(r.operationId,r);}}
 save(r){r.updatedAt=new Date().toISOString();const p=join(this.directory,r.operationId+'.json'),tmp=p+'.tmp';writeFileSync(tmp,JSON.stringify(r),{mode:0o600});renameSync(tmp,p);this.records.set(r.operationId,r);return r;}
 get(fileKey,id){const r=this.records.get(id);if(!r)throw failure('OPERATION_NOT_FOUND','Операция не найдена',{operationId:id});if(r.fileKey!==fileKey)throw failure('OPERATION_TARGET_MISMATCH','Назначение операции не совпадает',{operationId:id});const {resumeTokenHash,lastConnectionId,...publicRecord}=r;const result=structuredClone(publicRecord);if(result.recovery?.originalRecord){delete result.recovery.originalRecord.resumeTokenHash;delete result.recovery.originalRecord.lastConnectionId;}return result;}
 begin(input,connectionId,resumeToken=randomBytes(32).toString('hex')){this.assertNestedSwapReplayAllowed(input);this.assertNativeImportReplayAllowed(input);const operationId=input.operationId||randomUUID();if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationId))throw failure('INVALID_ARGUMENTS','Неверный operationId');const variableImport=Array.isArray(input.variables);const name=input.name||(variableImport?'import_variables':null);if(!name)throw failure('INVALID_ARGUMENTS','Не указано имя операции');const argsHash=variableImport?importArgsHash(input):operationArgsHash(input);if(this.records.has(operationId)){const r=this.get(input.fileKey,operationId);if(r.argsHash!==argsHash)throw failure('OPERATION_ARGUMENTS_MISMATCH','Аргументы операции изменились',{operationId});throw failure('OPERATION_ALREADY_EXISTS','Операция уже существует; прочитайте её журнал',{operationId,nextStep:'get_operation_status с теми же fileKey/operationId; затем inspect_selection затронутых ID/ключей. Не повторяйте runner для чтения ошибки.'});}for(const r of this.records.values())if(r.fileKey===input.fileKey&&!r.settled)throw failure('OPERATION_IN_PROGRESS','Операция записи уже выполняется',{operationId:r.operationId});return this.save({schemaVersion:2,resumeTokenHash:createHash('sha256').update(resumeToken).digest('hex'),operationId,fileKey:input.fileKey,name,argsHash,attempt:input.attempt||1,connectionId,stage:'dispatch',state:'pending',settled:false,commandSent:false,...(variableImport?{variables:structuredClone(input.variables)}:{operationInput:structuredClone(input.args)}),createdAt:new Date().toISOString(),sequence:0});}
 authorized(connectionId,e){const r=this.records.get(e?.operationId);if(!r||r.fileKey!==e.fileKey||r.argsHash!==e.argsHash)return false;if(connectionId===r.connectionId||connectionId===r.lastConnectionId)return true;if(typeof e.resumeToken!=='string'||!r.resumeTokenHash)return false;const actual=createHash('sha256').update(e.resumeToken).digest();return timingSafeEqual(actual,Buffer.from(r.resumeTokenHash,'hex'));}
 acknowledged(connectionId,e){const r=this.records.get(e?.operationId);return this.authorized(connectionId,e)&&Number.isInteger(e.sequence)&&e.sequence>0&&e.sequence<=r.sequence;}
 event(connectionId,e){const r=this.records.get(e?.operationId);
 // A normal response may beat its relayed terminal receipt. Acknowledge that
 // receipt without overwriting the already saved outcome or leaving relay retries.
 if(r?.receiptPending && r.settled && ['render_screen','patch_nodes'].includes(r.name) && e?.stage==='settled' && e.success===true && e.sequence===r.sequence+1 && this.authorized(connectionId,e)) {
  this.save({...r,sequence:e.sequence,lastConnectionId:connectionId,receiptPending:false});return true;
 }
 if(!this.authorized(connectionId,e)||!Number.isInteger(e.sequence)||e.sequence!==r.sequence+1||r.settled)return false;const allowed=r.name==='import_variables'?['native-import','variable-read','collection-read','verified','settled']:r.name==='use_component'?['component-import','instance-created','attached','verified','settled']:['verified','settled'];if(!allowed.includes(e.stage))return false;if(r.name==='import_variables'&&e.key&&!r.variables.some(v=>v.key===e.key))return false;if(e.id){if(typeof e.id!=='string')return false;if(r.name==='import_variables'){if(!e.key)return false;r.variables.find(v=>v.key===e.key).id=e.id;}else r.resourceId=e.id;}if(['render_screen','patch_nodes'].includes(r.name)&&e.stage==='settled') {
 const status=e.success?'applied':(e.operationStatus||'unknown');
 Object.assign(r,{lastConnectionId:connectionId,sequence:e.sequence,commandSent:true,settled:true,
  state:e.success?'verified':'failed',stage:e.success?'verified':r.stage,operationStatus:status,
  ...(e.success?{result:structuredClone(e.result)}:{error:{message:e.error,code:e.code,operationStatus:status,rollbackErrors:e.rollbackErrors}})});
 this.save(r);return true;
 }
 r.lastConnectionId=connectionId;r.sequence=e.sequence;r.commandSent=true;if(e.stage!=='settled')r.stage=e.stage;if(e.stage==='verified')r.state='verified';if(e.stage==='settled'){r.settled=true;const complete=r.name==='import_variables'?r.stage==='verified'&&r.variables.every(v=>typeof v.id==='string'&&v.id.length>0):r.stage==='verified'&&typeof r.resourceId==='string';r.state=e.success?(complete?'verified':'unknown'):'failed';r.operationStatus=e.success?(complete?'applied':'unknown'):(e.operationStatus||'unknown');r.code=e.success&&!complete?'OPERATION_JOURNAL_INCOMPLETE':e.code||null;}this.save(r);return true;}

 assertNestedSwapReplayAllowed(input) {
  if(input.name!=='swap_nested_components')return;
  if(typeof input.args?.operationKey!=='string'||!input.args.operationKey)throw failure('INVALID_ARGUMENTS','Nested swap requires stable operationKey');
  const hash=operationArgsHash(input),prior=[...this.records.values()].find(r=>r.fileKey===input.fileKey&&r.name===input.name&&r.operationInput?.operationKey===input.args.operationKey);
  if(prior)throw failure(prior.argsHash===hash?'OPERATION_ALREADY_EXISTS':'OPERATION_ARGUMENTS_MISMATCH','Nested swap already journaled; read its exact settled status and destination before recovery',{operationId:prior.operationId,argsHash:prior.argsHash});
  const a=input.args,c=this.records.get(a.creationOperationId),original=c?.operationInput;
  if(!c||c.schemaVersion!==2||c.operationId!==a.creationOperationId||c.stage!=='verified'||c.argsHash!==operationArgsHash({fileKey:c.fileKey,name:c.name,args:original})||c.fileKey!==input.fileKey||c.name!=='use_component'||c.settled!==true||c.state!=='verified'||c.operationStatus!=='applied'||c.commandSent!==true||c.resourceId!==a.rootId||original?.dryRun===true||original?.key!==a.rootKey||original?.fileKey!==input.fileKey||
    !(original.parentId===a.rootParentId||original.parentKey===a.rootParentKey)||
    !(original.libraryKey===a.rootLibraryKey||original.sourceId===a.rootSourceId))
   throw failure('NESTED_SWAP_CREATION_MISMATCH','Root requires exact settled verified instance creation receipt');

 }

 getRecoverableComponentDryRun({fileKey,operationId,argsHash}) {
  const r=this.get(fileKey,operationId);
  if(r.name!=='use_component'||r.operationInput?.dryRun!==true||
    typeof r.operationInput.libraryKey!=='string'||!r.operationInput.libraryKey||
    typeof r.operationInput.key!=='string'||!r.operationInput.key||
    r.operationInput.sourceId||r.operationInput.sourceKey||r.operationInput.fileKey!==fileKey||
    r.settled!==false||r.state!=='unknown'||r.operationStatus!=='unknown'||r.commandSent!==true||
    r.sequence!==0||r.stage!=='dispatch'||r.resourceId!==undefined)
   throw failure('DRY_RUN_RECOVERY_SCOPE_REJECTED','Восстановление разрешено только для отключённого use_component dryRun без событий и ID',{operationId});
  if(r.argsHash!==argsHash||operationArgsHash({fileKey:r.fileKey,name:r.name,args:r.operationInput})!==argsHash)
   throw failure('OPERATION_ARGUMENTS_MISMATCH','Хеш исходной операции не совпадает',{operationId});
  return r;
 }
 recoverComponentDryRun(input,proof) {
  const r=this.getRecoverableComponentDryRun(input);
  const idle=s=>s?.fileKey===r.fileKey&&s.responsive===true&&s.busy===false&&s.pendingExecutions===0&&s.activeOperation===null;
  if(proof?.oldConnectionAbsent!==true||proof.currentConnectionId===r.connectionId||
    typeof proof.currentConnectionId!=='string'||!proof.currentConnectionId||
    !idle(proof.before)||!idle(proof.after)||proof.readback?.fileKey!==r.fileKey||
    proof.readback.key!==r.operationInput.key||proof.readback.coverage?.complete!==true||
    !Array.isArray(proof.readback.coverage.pageIds)||!proof.readback.coverage.pageIds.length||
    !Number.isInteger(proof.readback.coverage.scannedNodes)||proof.readback.coverage.scannedNodes<1||
    !Array.isArray(proof.readback.matchIds)||proof.readback.matchIds.length!==0)
   throw failure('DRY_RUN_RECOVERY_PROOF_REJECTED','Не подтверждены новое свободное подключение и отсутствие ключа',{operationId:input.operationId});
  const originalRecord=structuredClone(this.records.get(input.operationId));
  this.save({...originalRecord,state:'unknown',operationStatus:'unknown',settled:true,
   recovery:{kind:'component-dry-run-disconnected',recoveredAt:new Date().toISOString(),
    canvasMutationExcluded:true,nativeImportOutcome:'unknown',replayAllowed:false,
    originalRecord,proof:structuredClone(proof)}});
  return this.get(input.fileKey,input.operationId);
 }
 assertNativeImportReplayAllowed(input) {
  if(!['use_component','assemble_library_template'].includes(input.name))return;
  const forbidden=[...this.records.values()].filter(r=>r.fileKey===input.fileKey&&
   r.recovery?.nativeImportOutcome==='unknown'&&r.recovery.replayAllowed===false);
  if(!forbidden.length)return;
  let keys;
  if(input.name==='use_component'){
   keys=input.args?.libraryKey?[input.args.libraryKey]:[];
   // A direct child key cannot prove independence from an unknown imported set.
   // Local sourceId operations and an explicit different set retain their route.
   const unknownSet=keys.length&&!input.args?.librarySetKey&&forbidden.find(r=>r.operationInput.librarySetKey);
   if(unknownSet)throw failure('NATIVE_IMPORT_REPLAY_FORBIDDEN','Неизвестен результат импорта набора; принадлежность прямого child key другому набору не подтверждена',{operationId:unknownSet.operationId});
  }
  else {
   if(input.mutating===false)return; // verify never imports components.
   if(!Array.isArray(input.componentImportKeys)||input.componentImportKeys.some(key=>typeof key!=='string'||!key))
    throw failure('NATIVE_IMPORT_REPLAY_FORBIDDEN','Не подтверждены ключи импорта сборки; повторный импорт запрещён',{operationId:forbidden[0].operationId});
   keys=input.componentImportKeys;
   // Assembly carries child keys only. After an unknown set import it cannot
   // prove that another child is outside that set; allow no-import operations
   // but do not dispatch another native import on this affected file.
   const unknownSet=keys.length&&forbidden.find(r=>r.operationInput.librarySetKey);
   if(unknownSet)throw failure('NATIVE_IMPORT_REPLAY_FORBIDDEN','Неизвестен результат импорта набора; принадлежность ключей сборки другому набору не подтверждена',{operationId:unknownSet.operationId});
  }
  const prior=forbidden.find(r=>keys.includes(r.operationInput.libraryKey)||input.name==='use_component'&&input.args?.librarySetKey&&input.args.librarySetKey===r.operationInput.librarySetKey);
  if(prior)throw failure('NATIVE_IMPORT_REPLAY_FORBIDDEN','Результат импорта этого компонента неизвестен; повторный импорт запрещён',{operationId:prior.operationId});
 }

 mark(id,fields){const r=this.records.get(id);if(!r)return;return this.save(Object.assign(r,fields));}
}
