<#
.SYNOPSIS
  Ejecuta un escalón de la prueba de carga de Tanta y guarda la evidencia.

.DESCRIPTION
  1. Repone los datos de prueba (stock y saldos) con preparar-datos.sql.
  2. Corre tests/carga.mjs en segundo plano.
  3. Mientras corre, muestrea pg_stat_activity / pg_locks cada ~1.5 s.
  4. Opcionalmente activa log_min_duration_statement para capturar el SQL lento
     (se revierte siempre al final, incluso si algo falla).
  5. Guarda todo en tests/evidencia/.

.EXAMPLE
  pwsh -File tests/escalon.ps1 -Concurrencia 40 -Duracion 25 -Etiqueta 40-vu -SqlLog 20
#>
param(
  [int]$Concurrencia = 20,
  [int]$Duracion = 25,
  [int]$Calentamiento = 4,
  [string]$Etiqueta = '',
  [int]$SqlLog = -1,          # -1 = no tocar; 0 = todas las consultas; >0 = solo las más lentas que N ms
  [string]$Xff = 'vu',
  [string]$Solo = ''
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz
if (-not $Etiqueta) { $Etiqueta = "$Concurrencia-vu" }

$evid = Join-Path $raiz 'tests/evidencia'
New-Item -ItemType Directory -Force -Path $evid | Out-Null
$node = 'C:\Users\jloyo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

function Psql {
  param([string]$sql)
  docker exec tanta-pg psql -U tanta -d tanta -t -A -F '|' -c $sql
}

$logSqlActivo = $false
try {
  # --- 1. preparar datos ---------------------------------------------------
  Write-Host "[escalon] preparando datos de prueba…"
  Get-Content (Join-Path $PSScriptRoot 'preparar-datos.sql') -Raw |
    docker exec -i tanta-pg psql -U tanta -d tanta -q -f - |
    Tee-Object -FilePath (Join-Path $evid "prep-$Etiqueta.log") | Out-Host

  $snapshotSql = @"
SELECT 'ventas=' || count(*) FROM core.venta
UNION ALL SELECT 'venta_detalle=' || count(*) FROM core.venta_detalle
UNION ALL SELECT 'movimientos=' || count(*) FROM core.movimiento_inventario
UNION ALL SELECT 'auditoria=' || count(*) FROM audit.evento
UNION ALL SELECT 'cobranza=' || count(*) FROM core.cobranza
"@
  $antes = Psql $snapshotSql
  $antes | Out-File (Join-Path $evid "snapshot-antes-$Etiqueta.log") -Encoding utf8

  # --- 2. log de consultas lentas -----------------------------------------
  if ($SqlLog -ge 0) {
    Psql "ALTER SYSTEM SET log_min_duration_statement = $SqlLog" | Out-Null
    Psql "ALTER SYSTEM SET log_lock_waits = on" | Out-Null
    Psql 'SELECT pg_reload_conf()' | Out-Null
    $logSqlActivo = $true
    Start-Sleep -Milliseconds 800
    Write-Host "[escalon] log_min_duration_statement=$SqlLog ms activo"
  }

  # --- 3. correr la carga --------------------------------------------------
  $argumentos = @(
    'tests/carga.mjs',
    "--concurrencia=$Concurrencia",
    "--duracion=$Duracion",
    "--calentamiento=$Calentamiento",
    "--etiqueta=$Etiqueta",
    "--salida=tests/resultados-$Etiqueta.json",
    "--xff=$Xff"
  )
  if ($Solo) { $argumentos += "--solo=$Solo" }

  $out = Join-Path $evid "salida-$Etiqueta.log"
  $errf = Join-Path $evid "salida-$Etiqueta.err.log"
  Write-Host "[escalon] lanzando $Concurrencia VU durante $Duracion s…"
  $proc = Start-Process -FilePath $node -ArgumentList $argumentos -RedirectStandardOutput $out `
    -RedirectStandardError $errf -PassThru -NoNewWindow

  # --- 4. muestrear PostgreSQL mientras corre ------------------------------
  $muestras = @()
  $limite = (Get-Date).AddSeconds($Duracion + $Calentamiento + 15)
  $sampleSql = @"
SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE datname='tanta' AND state='active')      || '|' ||
  (SELECT count(*) FROM pg_stat_activity WHERE datname='tanta' AND state='idle')        || '|' ||
  (SELECT count(*) FROM pg_stat_activity WHERE datname='tanta' AND wait_event_type='Lock') || '|' ||
  (SELECT count(*) FROM pg_locks WHERE NOT granted)                                    || '|' ||
  (SELECT count(*) FROM pg_stat_activity WHERE application_name='tanta-api')           || '|' ||
  (SELECT count(*) FROM pg_stat_activity WHERE datname='tanta' AND wait_event_type='IO')
"@
  while (-not $proc.HasExited -and (Get-Date) -lt $limite) {
    $hora = (Get-Date).ToString('HH:mm:ss')
    $muestras += "$hora|" + (Psql $sampleSql)
    Start-Sleep -Milliseconds 1200
  }
  $proc.WaitForExit()
  $muestras | Out-File (Join-Path $evid "pg-stat-$Etiqueta.log") -Encoding utf8

  # --- 5. cerrar evidencia -------------------------------------------------
  if ($logSqlActivo) {
    # Ojo: PostgreSQL escribe TODO por stderr y, con ErrorActionPreference='Stop',
    # PowerShell 5.1 convierte el stderr de un ejecutable nativo en error terminante.
    $pref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      docker logs --since "$($Duracion + $Calentamiento + 30)s" tanta-pg 2>&1 |
        Out-File (Join-Path $evid "pg-log-$Etiqueta.log") -Encoding utf8
    } finally {
      $ErrorActionPreference = $pref
    }
    Psql 'ALTER SYSTEM RESET log_min_duration_statement' | Out-Null
    Psql 'ALTER SYSTEM RESET log_lock_waits' | Out-Null
    Psql 'SELECT pg_reload_conf()' | Out-Null
    $logSqlActivo = $false
    Write-Host "[escalon] log de consultas restaurado"
  }

  $despues = Psql $snapshotSql
  $antes | ForEach-Object { "antes    $_" } | Out-Host
  $despues | ForEach-Object { "despues  $_" } | Out-Host

  Write-Host "[escalon] ───── salida de la corrida ─────"
  Get-Content $out -Encoding UTF8 | Out-Host
  if ((Get-Item $errf).Length -gt 0) {
    Write-Host "[escalon] stderr:" -ForegroundColor Yellow
    Get-Content $errf -Encoding UTF8 | Out-Host
  }
  Write-Host "[escalon] código de salida: $($proc.ExitCode)"
} finally {
  # Red de seguridad: nunca dejar el logging alterado.
  if ($logSqlActivo) {
    Psql 'ALTER SYSTEM RESET log_min_duration_statement' | Out-Null
    Psql 'ALTER SYSTEM RESET log_lock_waits' | Out-Null
    Psql 'SELECT pg_reload_conf()' | Out-Null
    Write-Host '[escalon] logging restaurado en finally' -ForegroundColor Yellow
  }
}
