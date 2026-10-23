# Starts the installed app on Windows and checks that it comes up for real:
#   - the process starts and stays alive;
#   - it shows a visible top-level window, which proves WebView2 loaded and the frontend ran.
# Writes the app's windows (with their sizes) and a screenshot to OUT, for the workflow to upload.
#
# Usage: launch-check.ps1 -App <path to AiN.exe> [-Out launch-check] [-Wait 60] [-Stay 10]
param(
  [Parameter(Mandatory = $true)][string]$App,
  [string]$Out = "launch-check",
  [int]$Wait = 60,
  [int]$Stay = 10
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class Windows {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lparam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  // The visible top-level windows of process `pid`, as "WIDTHxHEIGHT+X+Y".
  public static List<string> Of(uint pid) {
    var found = new List<string>();
    EnumWindows((hwnd, _) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      Rect r;
      if (owner == pid && IsWindowVisible(hwnd) && GetWindowRect(hwnd, out r))
        found.Add(String.Format("{0}x{1}+{2}+{3}", r.Right - r.Left, r.Bottom - r.Top, r.Left, r.Top));
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

function Save-Screen {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save((Join-Path $Out "screen.png"))
}

function Fail([string]$message) {
  Write-Output "::error::$message"
  try { Save-Screen } catch { }
  exit 1
}

$process = Start-Process -FilePath $App -PassThru
$windows = @()
for ($i = 0; $i -lt $Wait; $i++) {
  if ($process.HasExited) { Fail "the app exited (code $($process.ExitCode)) before showing a window" }
  $windows = [Windows]::Of([uint32]$process.Id)
  if ($windows.Count -gt 0) { break }
  Start-Sleep -Seconds 1
}
if ($windows.Count -eq 0) { Fail "no visible window after ${Wait}s: the web view or the frontend didn't start" }
Write-Output "The app shows its windows: $($windows -join ', ')"

# Let it run: a few beats of every widget, against the system as it is.
Start-Sleep -Seconds $Stay
if ($process.HasExited) { Fail "the app exited (code $($process.ExitCode)) within ${Stay}s of starting" }
[Windows]::Of([uint32]$process.Id) | Set-Content (Join-Path $Out "windows.txt")
try { Save-Screen } catch { Write-Output "No screenshot: $_" }
Write-Output "The app is up after ${Stay}s more, without a crash."
Stop-Process -Id $process.Id -Force
