# Cria (ou remove, com -Remover) os atalhos do JARVIS:
# Inicializacao do Windows (comeca escondido na bandeja), Area de Trabalho e Menu Iniciar.
param([switch]$Remover)
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root   = Split-Path -Parent $AppDir
$sh     = New-Object -ComObject WScript.Shell
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$vbs    = Join-Path $AppDir 'JARVIS.vbs'
$icone  = Join-Path $AppDir 'jarvis.ico'

$atalhos = @(
  @{ pasta = [Environment]::GetFolderPath('Startup');  args = '-Oculto' },
  @{ pasta = [Environment]::GetFolderPath('Desktop');  args = '' },
  @{ pasta = [Environment]::GetFolderPath('Programs'); args = '' }
)
foreach ($a in $atalhos) {
  $arq = Join-Path $a.pasta 'J.A.R.V.I.S..lnk'
  if ($Remover) { if (Test-Path $arq) { Remove-Item $arq -Force }; continue }
  $lnk = $sh.CreateShortcut($arq)
  $lnk.TargetPath = $wscript
  $lnk.Arguments = ('"' + $vbs + '" ' + $a.args).Trim()
  $lnk.WorkingDirectory = $Root
  $lnk.IconLocation = $icone
  $lnk.Description = 'J.A.R.V.I.S. - assistente de voz'
  $lnk.Save()
}
if (-not $Remover) {
  # Arquivos vindos de um zip baixado ficam "bloqueados" pelo Windows; libera os do JARVIS.
  Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike '*\node_modules\*' } |
    Unblock-File -ErrorAction SilentlyContinue
}
