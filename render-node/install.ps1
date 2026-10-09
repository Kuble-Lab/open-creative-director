# Installs the render agent of Open Creative Director on this computer (Windows) and pairs it (WP46).
# The app shows the command with a pairing code under "My computers":
#
#   & ([scriptblock]::Create((irm '<app>/api/render-agent/install.ps1'))) -Server '<app>' -Code '<code>'
#
# Needs Node.js 22 or newer (with npm). Fetches the package (setup.js) with the code and runs it: it installs the agent into
# %USERPROFILE%\ocd-render-agent, pairs the computer and starts the agent in the foreground. It never ends the PowerShell
# session it runs in (no "exit"): a failure is a message and a return.
param(
  [string]$Server = '',
  [string]$Code = '',
  [string]$Dir = (Join-Path $env:USERPROFILE 'ocd-render-agent'),
  [string]$Name = '',
  [switch]$NoStart
)

function Say([string]$de, [string]$en, [string]$es) {
  $lang = (Get-Culture).TwoLetterISOLanguageName
  if ($lang -eq 'de') { return $de }
  if ($lang -eq 'es') { return $es }
  return $en
}

if (-not $Server -or -not $Code) {
  Write-Host (Say "Aufruf: -Server <Adresse der App> -Code <Code>" "Usage: -Server <address of the app> -Code <code>" "Uso: -Server <dirección de la app> -Code <código>")
  return
}
$Server = $Server.TrimEnd('/')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host (Say "Node.js fehlt. Der Render-Agent braucht Node.js 22 oder neuer: https://nodejs.org/" "Node.js is missing. The render agent needs Node.js 22 or newer: https://nodejs.org/" "Falta Node.js. El agente de render necesita Node.js 22 o posterior: https://nodejs.org/")
  return
}
$major = 0
try { $major = [int](& node -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
if ($major -lt 22) {
  Write-Host (Say "Node.js ist zu alt. Der Render-Agent braucht Node.js 22 oder neuer: https://nodejs.org/" "Node.js is too old. The render agent needs Node.js 22 or newer: https://nodejs.org/" "Node.js es demasiado antiguo. El agente de render necesita Node.js 22 o posterior: https://nodejs.org/")
  return
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host (Say "npm fehlt (es gehört zu Node.js): https://nodejs.org/" "npm is missing (it comes with Node.js): https://nodejs.org/" "Falta npm (viene con Node.js): https://nodejs.org/")
  return
}

$setup = Join-Path ([IO.Path]::GetTempPath()) ("ocd-render-agent-" + [guid]::NewGuid().ToString('N') + ".js")
try {
  Invoke-WebRequest -UseBasicParsing -Headers @{ 'X-Render-Agent-Code' = $Code } -Uri "$Server/api/render-agent/package" -OutFile $setup
} catch {
  Write-Host (Say "Das Paket konnte nicht geladen werden. Ist der Code noch gültig (10 Minuten)? Sonst in der App einen neuen holen." "The package could not be loaded. Is the code still valid (10 minutes)? Otherwise get a new one in the app." "No se pudo descargar el paquete. ¿Sigue siendo válido el código (10 minutos)? Si no, pide uno nuevo en la app.")
  return
}

$arguments = @($setup, '--server', $Server, '--code', $Code, '--dir', $Dir)
if ($Name) { $arguments += @('--name', $Name) }
if ($NoStart) { $arguments += '--no-start' }
try {
  & node @arguments
} finally {
  Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
}
