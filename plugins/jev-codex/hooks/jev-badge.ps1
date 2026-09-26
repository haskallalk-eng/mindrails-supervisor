# Jev figure: a small note at the bottom right of the Claude or Codex window, where the
# model and effort menus are. Always on top, never takes the focus, closes on click or by
# itself. Started by the Jev prompt hook (src/jev-hook.ts, showBadge) with -Spec: a UTF-8
# JSON file {id, app, level, title, body, seconds}, so no text passes through a command
# line. When a newer figure starts, it rewrites the file with a new id and this one closes.
param(
  [string]$Spec = '',
  [ValidateSet('claude', 'codex')][string]$App = 'claude',
  [ValidateSet('note', 'stop')][string]$Level = 'note',
  [string]$Title = 'Jev',
  [string]$Body = '',
  [int]$Seconds = 15,
  [string]$Id = '',
  [string]$Log = ''
)
function Write-JevLog([string]$line) { if ($Log) { Add-Content -LiteralPath $Log -Value ("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $line) } }
function Read-JevSpec { if ($Spec -and (Test-Path -LiteralPath $Spec)) { Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json } }
$ErrorActionPreference = 'Stop'
$s = Read-JevSpec
if ($s) {
  if ($s.app -in 'claude', 'codex') { $App = $s.app }
  if ($s.level -in 'note', 'stop') { $Level = $s.level }
  $Title = [string]$s.title; $Body = [string]$s.body; $Id = [string]$s.id
  if ($s.seconds -gt 0) { $Seconds = [int]$s.seconds }
}
Write-JevLog "start app=$App level=$Level"
Add-Type -Namespace JevFigure -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern System.IntPtr SetProcessDpiAwarenessContext(System.IntPtr value);
[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr hWnd, int index);
[DllImport("user32.dll")] public static extern int SetWindowLong(System.IntPtr hWnd, int index, int value);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int cmd);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
# Per-monitor DPI awareness: window coordinates are physical pixels.
try { [void][JevFigure.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# The app window: the foreground window if it belongs to the app (the user just typed there), else its main window.
$names = if ($App -eq 'codex') { @('ChatGPT', 'Codex') } else { @('claude', 'Claude') }
$hwnd = [JevFigure.Native]::GetForegroundWindow()
$owner = [uint32]0
[void][JevFigure.Native]::GetWindowThreadProcessId($hwnd, [ref]$owner)
$proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
if (-not $proc -or $names -notcontains $proc.ProcessName) {
  $main = Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $main) { Write-JevLog "no $App window (foreground owner: $($proc.ProcessName))"; exit 0 }
  $hwnd = $main.MainWindowHandle
}
if ([JevFigure.Native]::IsIconic($hwnd)) { Write-JevLog "$App window minimized"; exit 0 }
$script:rect = New-Object JevFigure.Native+RECT
[void][JevFigure.Native]::GetWindowRect($hwnd, [ref]$script:rect)
$script:scale = [JevFigure.Native]::GetDpiForWindow($hwnd) / 96.0
if ($script:scale -le 0) { $script:scale = 1.0 }
Write-JevLog "target hwnd=$hwnd rect=$($script:rect.Left),$($script:rect.Top),$($script:rect.Right),$($script:rect.Bottom) scale=$($script:scale)"

$accent = if ($Level -eq 'stop') { '#E5484D' } else { '#F5A524' }
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Jev" WindowStyle="None" AllowsTransparency="True" Background="Transparent" Topmost="True"
        ShowInTaskbar="False" ShowActivated="False" ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        WindowStartupLocation="Manual" Opacity="0" Cursor="Hand">
  <Border Margin="10" CornerRadius="14" Background="#F21B1B1F" BorderBrush="$accent" BorderThickness="1.5" Padding="12,10,12,10">
    <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="2" Opacity="0.5"/></Border.Effect>
    <StackPanel Orientation="Horizontal">
      <Grid Width="36" Height="36" VerticalAlignment="Top" Margin="0,0,10,0">
        <Ellipse Fill="$accent"/>
        <TextBlock Text="J" FontFamily="Segoe UI" FontWeight="Bold" FontSize="19" Foreground="#1B1B1F" HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Grid>
      <StackPanel MaxWidth="290" VerticalAlignment="Center">
        <TextBlock x:Name="TitleText" FontFamily="Segoe UI" FontSize="14.5" FontWeight="SemiBold" Foreground="White" TextWrapping="Wrap"/>
        <TextBlock x:Name="BodyText" FontFamily="Segoe UI" FontSize="12.5" Foreground="#CFCFD6" TextWrapping="Wrap" Margin="0,3,0,0"/>
      </StackPanel>
      <TextBlock Text="&#x2198;" FontFamily="Segoe UI Symbol" FontSize="24" Foreground="$accent" VerticalAlignment="Bottom" Margin="10,0,0,-6"/>
    </StackPanel>
  </Border>
</Window>
"@
$script:window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
# Text is set as properties, never parsed as XAML.
$script:window.FindName('TitleText').Text = $Title
$script:window.FindName('BodyText').Text = $Body

$script:window.Add_SourceInitialized({
  # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW: never take the focus, never show in Alt+Tab.
  $h = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
  $ex = [JevFigure.Native]::GetWindowLong($h, -20)
  [void][JevFigure.Native]::SetWindowLong($h, -20, ($ex -bor 0x08000000 -bor 0x00000080))
})
$script:window.Add_Loaded({
  $script:window.Left = $script:rect.Right / $script:scale - $script:window.ActualWidth - 12
  $script:window.Top = $script:rect.Bottom / $script:scale - $script:window.ActualHeight - 64
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation 0, 1, ([TimeSpan]::FromMilliseconds(220))
  $script:window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
  $own = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
  if (-not [JevFigure.Native]::IsWindowVisible($own)) { [void][JevFigure.Native]::ShowWindow($own, 4) }  # SW_SHOWNOACTIVATE: a hidden start (STARTUPINFO) must not hide the figure
  Write-JevLog "win32 visible=$([JevFigure.Native]::IsWindowVisible($own)) shown left=$($script:window.Left) top=$($script:window.Top) size=$($script:window.ActualWidth)x$($script:window.ActualHeight) visible=$($script:window.IsVisible)"
})
$script:window.Add_MouseLeftButtonUp({ $script:window.Close() })
$script:window.Add_Closed({ [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })

$script:started = Get-Date
$script:timer = New-Object System.Windows.Threading.DispatcherTimer
$script:timer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:timer.Add_Tick({
  $replaced = $false
  if ($Id) { try { $now = Read-JevSpec; $replaced = -not $now -or [string]$now.id -ne $Id } catch { $replaced = $false } }
  if ($replaced -or ((Get-Date) - $script:started).TotalSeconds -ge $Seconds) { $script:timer.Stop(); $script:window.Close() }
})
$script:timer.Start()
$script:window.Show()
[System.Windows.Threading.Dispatcher]::Run()
