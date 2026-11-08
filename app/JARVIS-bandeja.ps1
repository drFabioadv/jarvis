# J.A.R.V.I.S. - app da bandeja do Windows
#
# Fica no icone da bandeja (a area da setinha ^ perto do relogio) e cuida de tudo:
#   - liga o cerebro e a interface escondidos, sem janela preta;
#   - abre a interface numa janela propria (Chrome em modo app);
#   - fechar ou minimizar a janela NAO desliga: ele continua ouvindo em segundo plano;
#   - quando ouve "Ei Jarvis", o icone acende e a janela aparece;
#   - "Sair" no menu do icone desliga de verdade.
#
# Iniciado por JARVIS.vbs (que esconde a janela do PowerShell).
#   -Oculto   comeca sem mostrar a janela (usado ao ligar o computador)
#   -Acao     modo acao (pode clicar, digitar e mexer em arquivos)

param([switch]$Oculto, [switch]$Acao)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root    = Split-Path -Parent $AppDir
$Dados   = Join-Path $env:LOCALAPPDATA 'JARVIS'
$Perfil  = Join-Path $Dados 'perfil-navegador'
$Config  = Join-Path $Dados 'config.json'
$Logs    = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $Dados, $Logs | Out-Null
$LogFile = Join-Path $Logs 'bandeja.log'

function Log($msg) {
  try { Add-Content -Path $LogFile -Value ("{0} {1}" -f (Get-Date -Format 'dd/MM/yyyy HH:mm:ss'), $msg) -Encoding UTF8 } catch {}
}

$FaceUrl   = 'http://127.0.0.1:4173/?app=1'
$BridgeUrl = 'http://127.0.0.1:8787/phase'
$Titulo    = 'J.A.R.V.I.S.'

# ------------------------------------------------------------- uma instancia so
# Se ja estiver rodando, abrir de novo so mostra a janela que ja existe.
$criado = $false
$mutex  = New-Object System.Threading.Mutex($true, 'Local\JARVIS-bandeja', [ref]$criado)
$pedidoMostrar = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\JARVIS-mostrar')
if (-not $criado) {
  $pedidoMostrar.Set() | Out-Null
  exit
}

# ------------------------------------------------------------- funcoes do Windows
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  public static int Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return (int)p; }

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct PLACEMENT {
    public int length, flags, showCmd; public POINT ptMin, ptMax; public RECT rcNormal;
  }
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref PLACEMENT p);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref PLACEMENT p);

  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
  const int OFF = -20000;

  /// Escondida = fora da tela e fora da barra de tarefas, mas ainda "visivel"
  /// para o Chrome, que assim nao pausa o microfone nem o reconhecimento de voz.
  public static bool Hidden = false;
  static RECT saved; static bool hasSaved = false;

  /// A janela do JARVIS: a do Chrome cujo titulo e exatamente o da pagina.
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString() == title) {
        var c = new StringBuilder(64);
        GetClassName(h, c, 64);
        if (c.ToString() == "Chrome_WidgetWin_1") { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static void Taskbar(IntPtr h, bool show) {
    long ex = GetLong(h, GWL_EXSTYLE).ToInt64();
    ex = show ? (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW : (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    SetLong(h, GWL_EXSTYLE, new IntPtr(ex));
  }

  public static void ToTray(IntPtr h) {
    var p = new PLACEMENT(); p.length = Marshal.SizeOf(p);
    GetWindowPlacement(h, ref p);
    var r = p.rcNormal;
    if (r.Left > OFF / 2 && r.Right - r.Left > 200) { saved = r; hasSaved = true; }
    int w = Math.Max(800, r.Right - r.Left), hgt = Math.Max(500, r.Bottom - r.Top);
    ShowWindow(h, 0);
    Taskbar(h, false);
    p.flags = 0; p.showCmd = 4; // SW_SHOWNOACTIVATE
    p.rcNormal.Left = OFF; p.rcNormal.Top = OFF; p.rcNormal.Right = OFF + w; p.rcNormal.Bottom = OFF + hgt;
    SetWindowPlacement(h, ref p);
    Hidden = true;
  }

  public static void FromTray(IntPtr h, bool activate, int x, int y, int w, int hgt) {
    var p = new PLACEMENT(); p.length = Marshal.SizeOf(p);
    GetWindowPlacement(h, ref p);
    ShowWindow(h, 0);
    Taskbar(h, true);
    if (hasSaved) p.rcNormal = saved;
    else { p.rcNormal.Left = x; p.rcNormal.Top = y; p.rcNormal.Right = x + w; p.rcNormal.Bottom = y + hgt; }
    p.flags = 0; p.showCmd = activate ? 1 : 4; // SW_SHOWNORMAL / SW_SHOWNOACTIVATE
    SetWindowPlacement(h, ref p);
    Hidden = false;
    // Na frente de tudo por um instante, sem prender ali.
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0013);
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0013);
    if (activate) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);       // ALT: libera o SetForegroundWindow
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      BringWindowToTop(h);
      SetForegroundWindow(h);
    }
  }
}
'@
[JarvisWin]::SetProcessDPIAware() | Out-Null

# ------------------------------------------------------------- configuracoes
$cfg = @{ mostrarAoOuvir = $true; primeiraVez = $true; modoAcao = $true }
if (Test-Path $Config) {
  try {
    $lido = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($k in 'mostrarAoOuvir', 'primeiraVez', 'modoAcao') { if ($null -ne $lido.$k) { $cfg[$k] = [bool]$lido.$k } }
  } catch {}
}
function Salvar-Config { try { ($cfg | ConvertTo-Json) | Set-Content -Path $Config -Encoding UTF8 } catch {} }

$Startup = [Environment]::GetFolderPath('Startup')
$AtalhoInicio = Join-Path $Startup 'J.A.R.V.I.S..lnk'

function Definir-IniciarComWindows([bool]$ligar) {
  if ($ligar) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($AtalhoInicio)
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $AppDir 'JARVIS.vbs') + '" -Oculto'
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = (Join-Path $AppDir 'jarvis.ico')
    $lnk.Description = 'J.A.R.V.I.S. - assistente de voz'
    $lnk.Save()
  } elseif (Test-Path $AtalhoInicio) {
    Remove-Item $AtalhoInicio -Force
  }
}

# ------------------------------------------------------------- navegador
function Achar-Navegador {
  # O Edge vem primeiro: ele traz as vozes neurais gratis do Windows
  # ("Antonio Online (Natural)"), bem menos robotizadas que as do Chrome.
  $opcoes = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $opcoes) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
$Navegador = Achar-Navegador
# Um perfil por navegador: Chrome e Edge nao podem dividir a mesma pasta.
if ($Navegador) { $Perfil = Join-Path $Dados ('perfil-' + [IO.Path]::GetFileNameWithoutExtension($Navegador)) }

# ------------------------------------------------------------- estado
$script:noProc     = $null    # node scripts\app.mjs
$script:navProc    = $null    # Chrome em modo app
$script:hwnd       = [IntPtr]::Zero
$script:saindo     = $false
$script:esconderAoAbrir = $true
$script:wakes      = -1
$script:fase       = ''
$script:ultimaFalha = Get-Date
$script:ultimaAbertura = (Get-Date).AddMinutes(-1)
$script:abrirOculto = $false

function Area-Padrao {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $w = [Math]::Min(1180, $wa.Width - 60); $h = [Math]::Min(760, $wa.Height - 60)
  return @(($wa.Left + [int](($wa.Width - $w) / 2)), ($wa.Top + [int](($wa.Height - $h) / 2)), $w, $h)
}

function Iniciar-Cerebro {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('Node.js nao encontrado. Rode o INSTALAR.bat primeiro.', 'J.A.R.V.I.S.') | Out-Null
    return $false
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + (Join-Path $Root 'scripts\app.mjs') + '"' + $(if ($Acao -or $cfg.modoAcao) { ' --writes' } else { '' })
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true   # quando a bandeja fecha, ele fecha junto
  $script:noProc = [System.Diagnostics.Process]::Start($psi)
  Log "cerebro iniciado (pid $($script:noProc.Id))"
  return $true
}

function Pronto($url) {
  try {
    $req = [System.Net.WebRequest]::Create($url)
    $req.Timeout = 700
    $res = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($res.GetResponseStream())
    $txt = $sr.ReadToEnd(); $res.Close()
    return $txt
  } catch { return $null }
}

function Abrir-Janela([bool]$oculta) {
  if (-not $Navegador) {
    [System.Windows.Forms.MessageBox]::Show('Nao encontrei o Google Chrome nem o Microsoft Edge.', 'J.A.R.V.I.S.') | Out-Null
    return
  }
  $a = Area-Padrao
  $argsNav = @(
    "--app=$FaceUrl",
    "--user-data-dir=`"$Perfil`"",
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    "--window-size=$($a[2]),$($a[3])"
  )
  if ($oculta) { $argsNav += '--window-position=-20000,-20000' } else { $argsNav += "--window-position=$($a[0]),$($a[1])" }
  $script:esconderAoAbrir = $oculta
  $script:hwnd = [IntPtr]::Zero
  [JarvisWin]::Hidden = $false
  $script:ultimaAbertura = Get-Date
  $script:navProc = Start-Process -FilePath $Navegador -ArgumentList $argsNav -PassThru
  Log "janela aberta (oculta=$oculta)"
}

function Mostrar([bool]$ativar = $true) {
  if ($script:hwnd -eq [IntPtr]::Zero -or -not [JarvisWin]::IsWindow($script:hwnd)) {
    $script:esconderAoAbrir = $false
    return
  }
  $a = Area-Padrao
  [JarvisWin]::FromTray($script:hwnd, $ativar, $a[0], $a[1], $a[2], $a[3])
}

function Esconder {
  if ($script:hwnd -ne [IntPtr]::Zero -and [JarvisWin]::IsWindow($script:hwnd)) {
    [JarvisWin]::ToTray($script:hwnd)
  }
}

function Parar-Tudo {
  $script:saindo = $true
  try { if ($script:noProc -and -not $script:noProc.HasExited) { $script:noProc.StandardInput.Close() } } catch {}
  # A janela pode pertencer a outro processo do Chrome; fecha pelo dono da janela.
  try {
    $h = [JarvisWin]::Find($Titulo)
    if ($h -ne [IntPtr]::Zero) { & taskkill.exe /PID ([JarvisWin]::Pid($h)) /T /F 2>$null | Out-Null }
  } catch {}
  foreach ($p in @($script:navProc, $script:noProc)) {
    try { if ($p -and -not $p.HasExited) { & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null } } catch {}
  }
}

# ------------------------------------------------------------- atualizacao automatica
# Procura versao nova no GitHub ao ligar e a cada 3 horas. Se houver, aplica
# sozinho quando ele estiver em espera (nunca no meio de uma conversa).
$script:upProc = $null
$script:upManual = $false
$script:upPendente = $null
$script:proximaChecagem = (Get-Date).AddSeconds(45)

function Iniciar-Checagem {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + (Join-Path $Root 'scripts\update.mjs') + '" --check'
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $script:upProc = [System.Diagnostics.Process]::Start($psi)
}

function Aplicar-Atualizacao([string]$msg) {
  Log "aplicando atualizacao: $msg"
  $tray.ShowBalloonTip(4000, 'J.A.R.V.I.S.', "Atualizando o JARVIS: $msg", 'Info')
  $estavaOculto = [JarvisWin]::Hidden
  Parar-Tudo
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  $up = Start-Process -FilePath $node -ArgumentList @(('"' + (Join-Path $Root 'scripts\update.mjs') + '"'), '--apply') -WorkingDirectory $Root -WindowStyle Hidden -Wait -PassThru
  Log "atualizacao terminou (codigo $($up.ExitCode)); reiniciando"
  $tray.Visible = $false
  try { $mutex.ReleaseMutex() } catch {}
  $arg = '"' + (Join-Path $AppDir 'JARVIS.vbs') + '"' + $(if ($estavaOculto) { ' -Oculto' } else { '' })
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList $arg
  [Environment]::Exit(0)
}

# ------------------------------------------------------------- icone da bandeja
function Icone($nome) {
  $f = Join-Path $AppDir $nome
  if (Test-Path $f) { return New-Object System.Drawing.Icon($f) }
  return [System.Drawing.SystemIcons]::Application
}
$icNormal = Icone 'jarvis.ico'
$icAtivo  = Icone 'jarvis-ativo.ico'
$icDesl   = Icone 'jarvis-desligado.ico'

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icDesl
$tray.Text = 'J.A.R.V.I.S. - ligando...'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miMostrar  = $menu.Items.Add('Mostrar JARVIS')
$miMostrar.Font = New-Object System.Drawing.Font($miMostrar.Font, [System.Drawing.FontStyle]::Bold)
$miEsconder = $menu.Items.Add('Esconder (continua ouvindo)')
$menu.Items.Add('-') | Out-Null
$miAoOuvir  = New-Object System.Windows.Forms.ToolStripMenuItem('Mostrar a janela quando ouvir "Ei Jarvis"')
$miAoOuvir.CheckOnClick = $true
$miAoOuvir.Checked = $cfg.mostrarAoOuvir
$menu.Items.Add($miAoOuvir) | Out-Null
$miAcao     = New-Object System.Windows.Forms.ToolStripMenuItem('Modo acao: abrir sites, videos, programas e procurar arquivos')
$miAcao.CheckOnClick = $true
$miAcao.Checked = $cfg.modoAcao
$menu.Items.Add($miAcao) | Out-Null
$miInicio   = New-Object System.Windows.Forms.ToolStripMenuItem('Iniciar com o Windows')
$miInicio.CheckOnClick = $true
$miInicio.Checked = (Test-Path $AtalhoInicio)
$menu.Items.Add($miInicio) | Out-Null
$menu.Items.Add('-') | Out-Null
$miReiniciar = $menu.Items.Add('Reiniciar JARVIS')
$miAtualizar = $menu.Items.Add('Procurar atualizacao agora')
$miVoz       = $menu.Items.Add('Voz natural (ElevenLabs)...')
$miIphone    = $menu.Items.Add('Atalho do iPhone (senha)')
$miConfig    = $menu.Items.Add('Preferencias (cidade, temas, modelo)')
$miLogs      = $menu.Items.Add('Abrir registros (para suporte)')
$menu.Items.Add('-') | Out-Null
$miSair      = $menu.Items.Add('Sair (desligar o JARVIS)')
$tray.ContextMenuStrip = $menu

$miMostrar.add_Click({ Mostrar $true })
$miEsconder.add_Click({ Esconder })
$miAoOuvir.add_Click({ $cfg.mostrarAoOuvir = $miAoOuvir.Checked; Salvar-Config })
$miInicio.add_Click({ try { Definir-IniciarComWindows $miInicio.Checked } catch { Log "atalho: $_" } })
$miAtualizar.add_Click({
  $script:upManual = $true
  $script:proximaChecagem = Get-Date
})
$miVoz.add_Click({
  $arq = Join-Path $Root 'elevenlabs.txt'
  if (-not (Test-Path $arq)) { New-Item -ItemType File -Path $arq -Force | Out-Null }
  [System.Windows.Forms.MessageBox]::Show(
    "Para uma voz bem natural, como uma pessoa falando:`n`n" +
    "1. Crie uma conta gratis em elevenlabs.io`n" +
    "2. Clique no seu perfil > API Keys > Create, e copie a chave`n" +
    "3. Cole a chave na primeira linha do Bloco de Notas que vai abrir e salve (Ctrl+S)`n" +
    "4. Clique no icone do JARVIS > Reiniciar JARVIS`n`n" +
    "Opcional: para escolher a voz, copie o ID de uma voz da Voice Library e cole em elevenlabs-voz.txt.",
    'J.A.R.V.I.S. - voz natural') | Out-Null
  Start-Process notepad.exe $arq
})
$miIphone.add_Click({ Start-Process notepad.exe (Join-Path $Root 'atalho-token.txt') })
$miConfig.add_Click({ Start-Process notepad.exe (Join-Path $Root 'jarvis-config.json') })
$miLogs.add_Click({ Start-Process explorer.exe $Logs })
$tray.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    if ([JarvisWin]::Hidden) { Mostrar $true } else { Esconder }
  }
})
$miAcao.add_Click({
  $cfg.modoAcao = $miAcao.Checked
  Salvar-Config
  $miReiniciar.PerformClick()
})
$miReiniciar.add_Click({
  Parar-Tudo
  Start-Sleep -Milliseconds 800
  $script:saindo = $false
  $script:wakes = -1
  $script:abrirOculto = $false
  $script:hwnd = [IntPtr]::Zero
  if (Iniciar-Cerebro) { $script:esperando = Get-Date }
})
$miSair.add_Click({
  Parar-Tudo
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

# ------------------------------------------------------------- relogio principal
# Uma batida a cada 300 ms: acompanha a janela, a fase e os pedidos de "mostrar".
$script:esperando = Get-Date     # desde quando espera o cerebro subir
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.add_Tick({
  try {
    if ($script:saindo) { return }

    # Alguem abriu o atalho de novo: mostrar a janela.
    if ($pedidoMostrar.WaitOne(0)) { Mostrar $true }

    # O cerebro caiu de vez? Sobe de novo.
    if ($script:noProc -and $script:noProc.HasExited) {
      Log 'cerebro encerrou; reiniciando'
      Iniciar-Cerebro | Out-Null
      $script:esperando = Get-Date
    }

    # Esperando a interface responder pela primeira vez.
    if ($script:esperando) {
      if ((Pronto 'http://127.0.0.1:4173/') -and (Pronto $BridgeUrl)) {
        $script:esperando = $null
        $existente = [JarvisWin]::Find($Titulo)
        if ($existente -ne [IntPtr]::Zero) { $script:hwnd = $existente; Mostrar $true }
        else { Abrir-Janela $script:abrirOculto }
        if ($cfg.primeiraVez) { $cfg.primeiraVez = $false; Salvar-Config }
      } elseif (((Get-Date) - $script:esperando).TotalSeconds -gt 120) {
        $tray.ShowBalloonTip(5000, 'J.A.R.V.I.S.', 'O JARVIS nao conseguiu ligar. Clique com o botao direito no icone > Abrir registros.', 'Warning')
        $script:esperando = $null
      }
      return
    }

    # Acha a janela assim que ela aparece.
    if ($script:hwnd -eq [IntPtr]::Zero -or -not [JarvisWin]::IsWindow($script:hwnd)) {
      $achada = [JarvisWin]::Find($Titulo)
      if ($achada -ne [IntPtr]::Zero) {
        $script:hwnd = $achada
        if ($script:esconderAoAbrir) { Esconder } else { Mostrar $true }
      } elseif (((Get-Date) - $script:ultimaAbertura).TotalSeconds -gt 12) {
        # Fechou no X (ou nunca abriu): continua em segundo plano, reabrindo escondida.
        Log 'janela fechada; reabrindo em segundo plano'
        Abrir-Janela $true
      }
    } elseif ([JarvisWin]::IsIconic($script:hwnd)) {
      # Minimizou: vai para a bandeja e continua ouvindo.
      Esconder
    }

    # Atualizacoes.
    if ($script:upProc -and $script:upProc.HasExited) {
      $res = $null
      try { $res = $script:upProc.StandardOutput.ReadToEnd() | ConvertFrom-Json } catch {}
      $script:upProc = $null
      $script:proximaChecagem = (Get-Date).AddHours(3)
      if ($res -and $res.ok -and $res.update) { $script:upPendente = [string]$res.message }
      elseif ($script:upManual) {
        $txt = if ($res -and -not $res.ok) { "Nao consegui verificar agora: $($res.error)" } else { 'O JARVIS ja esta na versao mais nova.' }
        $tray.ShowBalloonTip(3000, 'J.A.R.V.I.S.', $txt, 'Info')
      }
      $script:upManual = $false
    } elseif (-not $script:upProc -and (Get-Date) -gt $script:proximaChecagem) {
      Iniciar-Checagem
      $script:proximaChecagem = (Get-Date).AddHours(3)
    }
    if ($script:upPendente -and ($script:fase -eq 'dormant' -or $script:fase -eq '' -or $script:upManual)) {
      Aplicar-Atualizacao $script:upPendente
      return
    }

    # Fase da interface: icone, dica e o aviso de "ouvindo".
    $txt = Pronto $BridgeUrl
    if ($txt) {
      $st = $txt | ConvertFrom-Json
      if ($script:wakes -ge 0 -and $st.wakes -gt $script:wakes) {
        if ($cfg.mostrarAoOuvir) { if ([JarvisWin]::Hidden) { Mostrar $false } }
        elseif ([JarvisWin]::Hidden) { $tray.ShowBalloonTip(1500, 'J.A.R.V.I.S.', 'Ouvindo...', 'Info') }
      }
      $script:wakes = [int]$st.wakes
      if ($st.phase -ne $script:fase) {
        $script:fase = $st.phase
        switch ($st.phase) {
          'dormant'   { $tray.Icon = $icNormal; $tray.Text = 'J.A.R.V.I.S. - em espera (diga "Ei Jarvis")' }
          'waking'    { $tray.Icon = $icAtivo;  $tray.Text = 'J.A.R.V.I.S. - ouvindo' }
          'listening' { $tray.Icon = $icAtivo;  $tray.Text = 'J.A.R.V.I.S. - ouvindo' }
          'thinking'  { $tray.Icon = $icAtivo;  $tray.Text = 'J.A.R.V.I.S. - pensando' }
          'tooling'   { $tray.Icon = $icAtivo;  $tray.Text = 'J.A.R.V.I.S. - trabalhando' }
          'speaking'  { $tray.Icon = $icAtivo;  $tray.Text = 'J.A.R.V.I.S. - respondendo' }
          default     { $tray.Icon = $icDesl;   $tray.Text = 'J.A.R.V.I.S. - ligando...' }
        }
      }
    }
  } catch {
    if (((Get-Date) - $script:ultimaFalha).TotalSeconds -gt 10) { Log "erro: $_"; $script:ultimaFalha = Get-Date }
  }
})

# ------------------------------------------------------------- partida
Log "bandeja iniciada (oculto=$Oculto, acao=$Acao, navegador=$Navegador)"
$script:abrirOculto = ($Oculto -and -not $cfg.primeiraVez)
if (-not (Iniciar-Cerebro)) { $tray.Visible = $false; exit }
if (-not $Oculto) {
  $tray.ShowBalloonTip(3000, 'J.A.R.V.I.S.', 'Ligando... O JARVIS fica aqui na bandeja, perto do relogio.', 'Info')
}
$timer.Start()
[System.Windows.Forms.Application]::Run()

# Saiu pelo menu.
$timer.Stop()
$tray.Dispose()
Parar-Tudo
$mutex.ReleaseMutex()
