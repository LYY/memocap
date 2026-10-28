import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const encodedScan = Buffer.from(`
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8, $false)
$writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$current = $null
$operation = 'input'
try {
  Import-Module ($PSHOME + '\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')
  $request = ConvertFrom-Json -InputObject $reader.ReadToEnd()
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push([string]$request.root)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $operation = 'attributes'
    $attributes = [System.IO.File]::GetAttributes($current)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      $writer.WriteLine((@{ status = 'reparse'; path = $current } | ConvertTo-Json -Compress))
      $writer.Flush()
      exit 0
    }
    if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
      $operation = 'enumerate'
      foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
        $pending.Push($entry)
      }
    }
  }
  $writer.WriteLine('{"status":"ok"}')
  $writer.Flush()
  exit 0
} catch {
  $writer.WriteLine((@{ status = 'error'; operation = $operation; path = $current; message = $_.Exception.ToString() } | ConvertTo-Json -Compress))
  $writer.Flush()
  exit 1
}
`, "utf16le").toString("base64");

function metadataFailure(scanned, cause) {
  const details = `status=${scanned.status}, signal=${scanned.signal}; ${scanned.stderr || ""}; ${scanned.stdout || ""}`;
  const failure = new Error(`Windows policy metadata check failed: ${cause?.message || details}`, { cause });
  failure.diagnostics = scanned;
  return failure;
}

function reparsePath(scanned, directory) {
  const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(scanned.stdout));
  if (!report || Array.isArray(report) || typeof report !== "object") throw new Error("Expected one metadata result object");
  switch (report.status) {
    case "ok":
      if (Object.keys(report).length === 1) return null;
      break;
    case "reparse": {
      if (Object.keys(report).length !== 2 || typeof report.path !== "string" || !path.win32.isAbsolute(report.path)) break;
      const relative = path.win32.relative(directory, report.path);
      if (relative === ".." || relative.startsWith("..\\") || path.win32.isAbsolute(relative)) break;
      return report.path;
    }
  }
  throw new Error("Invalid or incomplete metadata result");
}

function metadataEnvironment(owned, systemRoot) {
  const profile = path.join(owned, "profile");
  const local = path.join(profile, "AppData", "Local");
  const roaming = path.join(profile, "AppData", "Roaming");
  const cache = path.join(local, "Microsoft", "Windows", "PowerShell");
  const temporary = path.join(owned, "tmp");
  for (const directory of [roaming, cache, temporary]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const system32 = path.win32.join(systemRoot, "System32");
  const powershell = path.win32.join(system32, "WindowsPowerShell", "v1.0");
  const drive = path.win32.parse(profile).root.replace(/[\\/]$/, "");
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [system32, systemRoot, powershell].join(";"),
    PSModulePath: path.win32.join(powershell, "Modules"),
    HOME: profile, USERPROFILE: profile, HOMEDRIVE: drive, HOMEPATH: profile.slice(drive.length),
    APPDATA: roaming, LOCALAPPDATA: local, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    PSModuleAnalysisCachePath: path.join(cache, "ModuleAnalysisCache"),
  };
}

export function inspectWindowsMetadata(directory, run = spawnSync) {
  const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) throw new Error("Windows policy metadata requires an absolute SystemRoot");
  const temporary = os.tmpdir();
  const relative = path.win32.relative(directory, temporary);
  if (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative)) {
    throw new Error("Windows policy metadata temporary parent is inside the scanned payload");
  }
  const owned = fs.mkdtempSync(path.join(temporary, "memocap-metadata-"));
  let failure;
  let observed;
  try {
    const env = metadataEnvironment(owned, systemRoot);
    const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const scanned = run(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScan], {
      input: Buffer.from(JSON.stringify({ root: directory }), "utf8"),
      timeout: 10000, maxBuffer: 65536, shell: false, windowsHide: true, cwd: owned, env,
    });
    if (scanned.error || scanned.status !== 0 || scanned.signal) throw metadataFailure(scanned, scanned.error);
    try { observed = reparsePath(scanned, directory); }
    catch (error) { throw metadataFailure(scanned, error); }
  } catch (error) {
    failure = error;
  } finally {
    try { fs.rmSync(owned, { recursive: true, force: true }); }
    catch (error) {
      const message = `Windows policy metadata cleanup failed (${error.code || error.name})`;
      failure = failure ? new AggregateError([failure, error], `${failure.message}; ${message}`, { cause: failure })
        : new Error(message, { cause: error });
    }
  }
  if (failure) throw failure;
  return observed;
}
