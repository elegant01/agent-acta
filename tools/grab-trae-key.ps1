# grab-trae-key.ps1 — capture the SQLCipher key (traeKey) of Trae CN / Trae Work
# from the AI host process memory, for agentLog's traedb source.
#
# Usage (Trae must be running):
#   powershell -ExecutionPolicy Bypass -File grab-trae-key.ps1
#   powershell -ExecutionPolicy Bypass -File grab-trae-key.ps1 -Minutes 10 -NoElevate
#
#   -OutFile <path>   machine-readable mode (used by the agentLog page button):
#                     write a one-line JSON result {ok, key?, error?, message?} to <path>.
#                     The elevated relaunch gets -OutFile too (its stdout is not
#                     readable by the parent), and the script never waits for Enter.
param(
    [int]$Minutes = 5,
    [switch]$NoElevate,
    [string]$OutFile = ''
)

# How it works:
#   1. Sweep every Trae* process unelevated (~20s). If the key string is visible, done.
#   2. Otherwise it relaunches itself elevated (one UAC prompt). The AI host process
#      denies PROCESS_VM_READ to unelevated callers (Trae ships an anti-tamper DLL),
#      so admin rights are required for the real deal.
#   3. The scanner looks for the SQLCipher statement the sqlx runtime builds:
#         PRAGMA key = "x'<64 hex>'";
#      That string stays resident in the host process heap for hours once the app
#      has opened its database, so a plain memory sweep finds it.
#   4. If nothing shows up: open Trae CN and send one AI chat message (that opens
#      the DB), or restart Trae CN while this scanner keeps running.

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class TraeKeyGrab {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION64 mbi, UIntPtr len);
    [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, UIntPtr size, out UIntPtr read);

    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION64 {
        public ulong BaseAddress; public ulong AllocationBase; public uint AllocationProtect;
        public uint __align1; public ulong RegionSize; public uint State; public uint Protect; public uint Type; public uint __align2;
    }
    const uint PROCESS_VM_READ = 0x10, PROCESS_QUERY_INFORMATION = 0x400;
    const uint MEM_COMMIT = 0x1000;
    const uint PAGE_NOACCESS = 0x01, PAGE_GUARD = 0x100;
    const int CHUNK = 8 * 1024 * 1024, OVERLAP = 512;

    static byte[][] markers = new byte[][] {
        Encoding.ASCII.GetBytes("PRAGMA key = \"x'"),
        Encoding.ASCII.GetBytes("PRAGMA key = 'x"),
        Encoding.ASCII.GetBytes("PRAGMA key = x'"),
    };

    // Returns the candidate key strings found in the process. openErr != null means
    // the process could not be opened for reading.
    public static List<string> Scan(int pid, out string openErr) {
        openErr = null;
        var found = new List<string>();
        IntPtr h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
        if (h == IntPtr.Zero) { openErr = "access denied"; return found; }
        ulong addr = 0;
        while (addr < 0x7FFFFFFFFFFF) {
            MEMORY_BASIC_INFORMATION64 mbi;
            if (VirtualQueryEx(h, (IntPtr)addr, out mbi, (UIntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION64))) == 0) break;
            bool readable = mbi.State == MEM_COMMIT && (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) == 0;
            bool isImage = mbi.Type == 0x1000000;
            if (readable && !isImage && mbi.RegionSize > 0) {
                ulong pos = mbi.BaseAddress, end = mbi.BaseAddress + mbi.RegionSize;
                while (pos < end) {
                    ulong rest = end - pos;
                    int want = (int)Math.Min((ulong)CHUNK, rest);
                    bool tail = (ulong)want < rest;
                    byte[] buf = new byte[want + (tail ? OVERLAP : 0)];
                    UIntPtr read;
                    if (ReadProcessMemory(h, (IntPtr)pos, buf, (UIntPtr)buf.Length, out read) && (ulong)read > 0) {
                        int len = (int)(ulong)read;
                        foreach (var mk in markers) {
                            int i = 0;
                            while (true) {
                                i = IndexOf(buf, mk, len, i);
                                if (i < 0) break;
                                var sb = new StringBuilder();
                                for (int j = i; j < len && j < i + 200; j++) { byte c = buf[j]; if (c < 0x20 || c > 0x7e) break; sb.Append((char)c); }
                                string s = sb.ToString();
                                if (s.Length > mk.Length + 64 && !s.Contains("@.") && !found.Contains(s)) found.Add(s);
                                i += mk.Length;
                            }
                        }
                    }
                    pos += (ulong)want;
                }
            }
            ulong next = mbi.BaseAddress + mbi.RegionSize;
            if (next <= addr) break;
            addr = next;
        }
        CloseHandle(h);
        return found;
    }

    static int IndexOf(byte[] hay, byte[] needle, int len, int from) {
        int limit = Math.Min(len, hay.Length) - needle.Length;
        for (int i = from; i <= limit; i++) {
            bool ok = true;
            for (int j = 0; j < needle.Length; j++) if (hay[i + j] != needle[j]) { ok = false; break; }
            if (ok) return i;
        }
        return -1;
    }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies System

function Get-TraePids {
    @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '(?i)trae|agent-tool|harness' } |
        Select-Object -ExpandProperty Id)
}

function Get-KeyFromPid([int]$pid_, [ref]$why) {
    $why.Value = ''
    $key = $null
    $err = $null
    try { $hits = [TraeKeyGrab]::Scan($pid_, [ref]$err) } catch { $why.Value = 'scan error'; return $null }
    if ($err) { $why.Value = $err; return $null }
    foreach ($s in $hits) {
        $m = [regex]::Match($s, "x'([0-9a-fA-F]{64})'")
        if ($m.Success) { $key = $m.Groups[1].Value.ToLower(); $why.Value = "hit: $s"; break }
    }
    if (-not $key) { $why.Value = 'no key string' }
    return $key
}

function Show-Result([string]$key) {
    Write-Host ''
    Write-Host '================================================================'
    Write-Host ' traeKey (SQLCipher key for Trae):'
    Write-Host ''
    Write-Host "   $key"
    Write-Host ''
    Write-Host ' (also copied to clipboard)'
    Write-Host ' Paste it into the agentLog config, trae entry "traeKey" field:'
    Write-Host "   $(Join-Path $env:USERPROFILE '.agent-log\config.json')"
    Write-Host '================================================================'
    Write-Host ''
    try { Set-Clipboard -Value $key } catch {}
}

# 服务器模式（-OutFile）：把结构化结果写成一行 JSON。提权实例的 stdout 父进程收不到，
# 只有这个文件能把「抓到没有 / 为什么没抓到」带回给服务端（服务端读后即删）。
function Write-Result([bool]$ok, [string]$code, [string]$message, [string]$key) {
    if (-not $OutFile) { return }
    $obj = @{ ok = $ok }
    if ($key) { $obj['key'] = $key }
    if ($code) { $obj['error'] = $code }
    if ($message) { $obj['message'] = $message }
    try {
        $json = $obj | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
}

$script:traeSeen = $false   # 这次运行里出现过 Trae 进程吗（区分失败原因：没有 Trae / 有 Trae 但没抓到）

function New-Sweep([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $announced = $false
    while ((Get-Date) -lt $deadline) {
        $pids = Get-TraePids   # 每轮重取：Trae 可能刚开始启动（从页面点完按钮才去开 Trae 是常态）
        if ($pids.Count -eq 0) {
            if (-not $announced) { Write-Host 'No Trae process yet - waiting for Trae CN to start...'; $announced = $true }
        } else {
            $script:traeSeen = $true
            if (-not $announced) { Write-Host ("Trae processes: " + ($pids -join ', ') + "   (admin: $isAdmin)"); $announced = $true }
            foreach ($p in $pids) {
                $why = ''
                $key = Get-KeyFromPid $p ([ref]$why)
                $tag = if ($why -eq 'access denied') { 'blocked (needs admin)' } else { $why }
                Write-Host ("  pid $p : $tag")
                if ($key) { return $key }
            }
        }
        Start-Sleep -Seconds 2
    }
    return $null
}

try {
    Write-Host '=== grab-trae-key: Trae SQLCipher key capture ==='

    # Phase 1: quick unelevated sweep. The AI host process may or may not expose the
    # string without elevation; some machines/processes do.
    $key = New-Sweep -seconds 20

    if (-not $key -and -not $isAdmin -and -not $NoElevate) {
        if (-not $script:traeSeen) {
            # 连一个 Trae 进程都没有：提权也无事可做，直接给结论（别再白弹一次 UAC）
            Write-Host 'No Trae process found. Open Trae CN first (and use the AI chat once).'
        } else {
            Write-Host ''
            Write-Host 'Trae host process denies memory reads to non-admin users (anti-tamper).'
            Write-Host 'Relaunching this script as administrator (one UAC prompt)...'
            Write-Host 'While it scans: open Trae CN and send one AI chat message, or restart Trae CN.'
            $args_ = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Minutes', "$Minutes")
            if ($OutFile) { $args_ += @('-OutFile', "`"$OutFile`"") }
            $proc_ = $null
            try {
                $proc_ = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $args_ -PassThru
            } catch {
                Write-Host "Elevation failed or was canceled: $($_.Exception.Message)"
                Write-Result $false 'elevation-canceled' $_.Exception.Message $null
            }
            if ($OutFile) {
                if (-not $proc_) {
                    # 取消 UAC 在 PS 5.1 里有时既不抛异常也不返回进程对象 —— 只能这样认出来。
                    # 认不出来就会让服务端干等 5 分钟，所以这一步不能省。
                    Write-Host 'Elevation did not start (UAC was canceled).'
                    Write-Result $false 'elevation-canceled' '' $null
                } else {
                    # 服务端以「本进程退出」为完成信号，所以提权接管之后本进程不能先走：
                    # 等结果文件出现（提权实例写完即退），最多等到它的扫描窗口 + 2 分钟余量。
                    $waitUntil = (Get-Date).AddSeconds($Minutes * 60 + 120)
                    while ((Get-Date) -lt $waitUntil -and -not (Test-Path -LiteralPath $OutFile)) {
                        Start-Sleep -Seconds 2
                    }
                }
            }
            exit
        }
    } elseif (-not $key) {
        Write-Host ''
        Write-Host "Key not found yet. Keep scanning for $Minutes minute(s)."
        Write-Host 'Trigger the DB open in Trae: send one AI chat message, or restart Trae CN.'
        $key = New-Sweep -seconds ($Minutes * 60)
    }

    if ($key) {
        Show-Result $key
        Write-Result $true '' '' $key
    } else {
        $code = if ($script:traeSeen) { 'no-key' } else { 'no-trae-process' }
        Write-Host ''
        Write-Host 'No key found. Checklist:'
        Write-Host '  1. Trae CN is running and you have used the AI chat at least once.'
        Write-Host '  2. Run this script as administrator (right-click > Run as administrator).'
        Write-Host '  3. Try again right after restarting Trae CN.'
        Write-Result $false $code '' $null
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Result $false 'scan-error' $_.Exception.Message $null
}

if (($isAdmin -or $NoElevate) -and -not $OutFile) {
    Write-Host 'Press Enter to close...'
    [void](Read-Host)
}
