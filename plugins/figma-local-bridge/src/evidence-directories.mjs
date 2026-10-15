import {execFileSync} from 'node:child_process';
import {mkdir,lstat,open} from 'node:fs/promises';
import {dirname} from 'node:path';
import {assertPrivate} from './installation.mjs';

// DirectorySecurity is supplied to CreateDirectory, not applied afterwards.
// .NET Framework passes it to native creation of missing directories only:
// https://github.com/microsoft/referencesource/blob/main/mscorlib/system/io/directory.cs
// Existing paths (including a concurrent creator's path) retain their ACL.
export const windowsEvidenceDirectoryScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = $env:FIGMA_EVIDENCE_CREATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in @($sid, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::CreateDirectory($path, $acl) | Out-Null
`;

export function createWindowsEvidenceDirectory(path, run = execFileSync) {
 run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(windowsEvidenceDirectoryScript,'utf16le').toString('base64')],{
  env:{...process.env,FIGMA_EVIDENCE_CREATE_PATH:path},stdio:'pipe',windowsHide:true,
 });
}
export async function syncEvidenceDirectory(path) {
 if(process.platform==='win32')return;
 const directory=await open(path,'r');try{await directory.sync();}finally{await directory.close();}
}
export async function ensureEvidenceDirectory(path) {
 let existing;
 try{existing=await lstat(path);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(existing){
  if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('Evidence path must be a directory, not a symlink');
  await assertPrivate(path,true);return;
 }
 if(process.platform==='win32') {
  createWindowsEvidenceDirectory(path);
 } else {
  try{await mkdir(path,{mode:0o700});await syncEvidenceDirectory(dirname(path));}
  catch(error){
   if(error.code==='ENOENT'){await makeMissingParents(dirname(path));return ensureEvidenceDirectory(path);}
   if(error.code!=='EEXIST')throw error;
  }
 }
 // No ACL repair/chmod for existing paths. Both branches verify after creation.
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Evidence path must be a directory, not a symlink');
 await assertPrivate(path,true);
}
async function makeMissingParents(path) {
 try{await mkdir(path,{mode:0o700});await syncEvidenceDirectory(dirname(path));}
 catch(error){
  if(error.code==='ENOENT'){await makeMissingParents(dirname(path));return makeMissingParents(path);}
  if(error.code!=='EEXIST')throw error;
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('Evidence parent must be a directory, not a symlink');
 }
}
