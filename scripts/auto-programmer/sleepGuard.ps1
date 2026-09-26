<#
.SYNOPSIS
  index.mjs（auto-programmer）が生きている間、Windows のアイドルスリープを止める。

.DESCRIPTION
  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) は、呼び出したスレッドが生きている間だけ
  効くユーザーレベルの API で、管理者権限は要らない。caffeinate -w のような「指定した pid を見て自分で
  終わる」仕組みが Windows には無いため、このスクリプト自身が -TargetPid をポーリングして代わりを務める。

.PARAMETER TargetPid
  生きている間だけスリープを止めたいプロセスの pid（index.mjs 自身の process.pid）。
#>
param(
  [Parameter(Mandatory = $true)]
  [int]$TargetPid
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class SleepGuardNativeMethods
{
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

# ビットの意味は winnt.h の定義どおり。ES_CONTINUOUS を毎回含めないと、この呼び出し1回限りで抑止が切れる
$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001

try {
  [SleepGuardNativeMethods]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null

  while (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
    Start-Sleep -Seconds 5
  }
}
finally {
  # ES_CONTINUOUS 単体に戻す＝前回立てたフラグを解除する（Microsoft のドキュメント記載の定石）
  [SleepGuardNativeMethods]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
