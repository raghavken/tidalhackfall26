param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Program', 'StartRelay', 'CheckRelay', 'StopRelay')]
    [string]$Action,
    [string]$QuartusBin,
    [string]$ProjectDir,
    [string]$Cable = '1',
    [int]$Device = 1,
    [string]$ScriptPath,
    [string]$ListenIp,
    [string]$NodePath,
    [string]$PidFile,
    [int]$RelayPid
)

$ErrorActionPreference = 'Stop'
switch ($Action) {
    'Program' {
        $fpga = Split-Path -Parent $ProjectDir
        $build = Join-Path $fpga 'build\launcher'
        $quartus = Join-Path $build 'quartus'
        $rtl = Join-Path $build 'rtl'
        New-Item -ItemType Directory -Path $quartus, $rtl -Force | Out-Null
        foreach ($name in @('de1.qpf', 'de1.qsf', 'de1.sdc')) {
            Copy-Item -LiteralPath (Join-Path $ProjectDir $name) -Destination $quartus -Force
        }
        Copy-Item -Path (Join-Path $fpga 'rtl\*.v') -Destination $rtl -Force
        Set-Location -LiteralPath $quartus
        & (Join-Path $QuartusBin 'quartus_sh.exe') --flow compile de1
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $operation = "P;output_files\de1.sof@$Device"
        & (Join-Path $QuartusBin 'quartus_pgm.exe') -c $Cable -m JTAG -o $operation
        exit $LASTEXITCODE
    }
    'StartRelay' {
        if (!(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ListenIp -ErrorAction SilentlyContinue)) {
            throw "IPv4 address $ListenIp is not assigned to this Windows host."
        }
        $root = Split-Path -Parent (Split-Path -Parent $ScriptPath)
        $logDir = Join-Path $root 'fpga\build'
        if (!$NodePath) { $NodePath = (Get-Command node.exe).Source }
        $arguments = '"{0}" {1} 3000' -f $ScriptPath, $ListenIp
        $relay = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $env:SystemRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'relay.log') -RedirectStandardError (Join-Path $logDir 'relay-error.log') -PassThru
        [IO.File]::WriteAllText($PidFile, [string]$relay.Id)
    }
    'CheckRelay' {
        $health = Invoke-RestMethod -Uri "http://${ListenIp}:3000/api/health" -TimeoutSec 5
        if ($health.status -ne 'ok') { throw 'The Windows Wi-Fi relay did not reach the simulator.' }
    }
    'StopRelay' {
        $relay = Get-Process -Id $RelayPid -ErrorAction SilentlyContinue
        if ($relay -and $relay.ProcessName -eq 'node') { Stop-Process -InputObject $relay }
    }
}
