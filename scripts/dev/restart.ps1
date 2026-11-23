# Restart the local dev API server (port 8787): stop whatever listens there, start scripts/dev/server.ts again.
#   powershell -NoProfile -File scripts/dev/restart.ps1
$c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
foreach ($x in $c) { Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue }
$env:PULSE_DEV_MONITORS = "0"
Start-Process -FilePath node -ArgumentList "--import", "./scripts/dev/register.mjs", "scripts/dev/server.ts" -RedirectStandardOutput ".data/dev-api.log" -RedirectStandardError ".data/dev-api.err" -WindowStyle Hidden
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try { $r = Invoke-WebRequest -Uri "http://localhost:8787/healthz" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { "dev server up"; exit 0 } } catch {}
}
"dev server did not start"; exit 1
