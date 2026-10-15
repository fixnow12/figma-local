import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,chmod,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ensureEvidenceDirectory,createWindowsEvidenceDirectory,windowsEvidenceDirectoryScript} from '../src/evidence-directories.mjs';
import {claimEvidence,writeEvidence} from '../src/call-evidence.mjs';

function powershell(script,path) {
 return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
  env:{...process.env,FIGMA_EVIDENCE_TEST_PATH:path},encoding:'utf8',windowsHide:true,stdio:'pipe',
 });
}
function windowsSecurity(path) {
 return JSON.parse(powershell(`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$acl=(Get-Item -LiteralPath $env:FIGMA_EVIDENCE_TEST_PATH -Force).GetAccessControl()
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
 @{sid=$_.IdentityReference.Value;allow=($_.AccessControlType -eq 'Allow');inherited=$_.IsInherited;inheritance=$_.InheritanceFlags.ToString()}
})
@{sddl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner,Group,Access');protected=$acl.AreAccessRulesProtected;user=$sid;rules=$rules} | ConvertTo-Json -Depth 5 -Compress
`,path));
}
function makePublicWindowsFixture(path) {
 // Apply a broad descriptor only while creating a NEW synthetic fixture.
 powershell(`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
$world=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($world,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
[System.IO.Directory]::CreateDirectory($env:FIGMA_EVIDENCE_TEST_PATH,$acl) | Out-Null
`,path);
}
function assertWindowsPrivate(security) {
 assert.ok(security.rules.length>0);
 assert.ok(security.rules.filter(rule=>rule.allow).every(rule=>[security.user,'S-1-5-18'].includes(rule.sid)));
}

test('Windows invocation contract (stub): create-time descriptor, no existing-item ACL setter',()=>{
 let call;
 createWindowsEvidenceDirectory("C:\\synthetic\\quote'$(ignored)",(...args)=>{call=args;});
 assert.equal(call[0],'powershell.exe');assert.equal(call[2].windowsHide,true);
 assert.equal(call[2].env.FIGMA_EVIDENCE_CREATE_PATH,"C:\\synthetic\\quote'$(ignored)");
 const script=Buffer.from(call[1].at(-1),'base64').toString('utf16le');
 assert.equal(script,windowsEvidenceDirectoryScript);
 assert.match(script,/\[System.IO.Directory\]::CreateDirectory\(\$path, \$acl\)/);
 assert.match(script,/SetAccessRuleProtection\(\$true, \$false\)/);
 assert.match(script,/ContainerInherit,ObjectInherit/);
 assert.doesNotMatch(script,/SetAccessControl|Set-Acl|icacls|chmod|quote/);
});

test('POSIX nested creation preserves existing parent mode and rejects unsafe writes before payload',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'evidence-posix-'));
 try{
  await chmod(root,0o755);await writeFile(join(root,'keep'),'keep');
  await ensureEvidenceDirectory(join(root,'new','nested'));
  assert.equal((await stat(root)).mode&0o777,0o755);
  assert.equal((await stat(join(root,'new'))).mode&0o777,0o700);
  assert.equal((await stat(join(root,'new','nested'))).mode&0o777,0o700);
  await assert.rejects(writeEvidence(join(root,'must-not-exist'),'synthetic payload'),/права/);
  await assert.rejects(lstat(join(root,'must-not-exist')),{code:'ENOENT'});
  assert.equal(await readFile(join(root,'keep'),'utf8'),'keep');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows ACL: new ancestors, directory and file are private while existing parent stays unchanged',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'evidence-new-acl-'));
 try{
  const parent=join(root,'public-parent');makePublicWindowsFixture(parent);
  const before=windowsSecurity(parent);assert.ok(before.rules.some(rule=>rule.allow&&rule.sid==='S-1-1-0'));
  const directory=join(parent,'new','nested');await ensureEvidenceDirectory(directory);
  for(const path of [join(parent,'new'),directory]){
   const actual=windowsSecurity(path);assertWindowsPrivate(actual);assert.equal(actual.protected,true);
  }
  const path=join(directory,'payload.json');await writeEvidence(path,'synthetic-only');
  assertWindowsPrivate(windowsSecurity(path));assert.equal(await readFile(path,'utf8'),'synthetic-only');
  assert.equal(windowsSecurity(parent).sddl,before.sddl);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows ACL: existing permissive output and unsafe file parent fail without ACL/data changes',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'evidence-existing-acl-'));
 try{
  const directory=join(root,'public-output');makePublicWindowsFixture(directory);
  await writeFile(join(directory,'keep'),'keep');const before=windowsSecurity(directory).sddl;
  await assert.rejects(claimEvidence({output:directory,tool:'fixture',args:{}}),/permissions are not private/);
  await assert.rejects(writeEvidence(join(directory,'payload'),'synthetic-only'),/permissions are not private/);
  await assert.rejects(lstat(join(directory,'request.json')),{code:'ENOENT'});
  await assert.rejects(lstat(join(directory,'payload')),{code:'ENOENT'});
  assert.equal(windowsSecurity(directory).sddl,before);assert.equal(await readFile(join(directory,'keep'),'utf8'),'keep');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows ACL: existing private directory is verified without rewriting its descriptor',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'evidence-private-existing-'));
 try{
  const directory=join(root,'private');await ensureEvidenceDirectory(directory);
  const before=windowsSecurity(directory).sddl;await ensureEvidenceDirectory(directory);
  assert.equal(windowsSecurity(directory).sddl,before);
  await writeEvidence(join(directory,'new-file'),'synthetic-only');assertWindowsPrivate(windowsSecurity(join(directory,'new-file')));
  assert.equal(windowsSecurity(directory).sddl,before);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows ACL: verify new file before payload even when private parent has no inheritable ACEs',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'evidence-file-default-acl-'));
 try{
  const directory=join(root,'private-no-inheritance');
  powershell(`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')))
}
[System.IO.Directory]::CreateDirectory($env:FIGMA_EVIDENCE_TEST_PATH,$acl) | Out-Null
`,directory);
  const before=windowsSecurity(directory);assertWindowsPrivate(before);
  assert.ok(before.rules.every(rule=>rule.inheritance==='None'));
  const path=join(directory,'payload');let failure;
  try{await writeEvidence(path,'synthetic-only');}catch(error){failure=error;}
  const actual=windowsSecurity(path);
  const privateFile=actual.rules.length>0&&actual.rules.filter(rule=>rule.allow).every(rule=>[actual.user,'S-1-5-18'].includes(rule.sid));
  if(privateFile){assert.equal(failure,undefined);assert.equal(await readFile(path,'utf8'),'synthetic-only');}
  else {assert.match(failure?.message,/permissions are not private/);assert.equal(await readFile(path,'utf8'),'');}
  assert.equal(windowsSecurity(directory).sddl,before.sddl);
 }finally{await rm(root,{recursive:true,force:true});}
});
