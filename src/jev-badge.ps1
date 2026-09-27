# Jev figure: a small note at the bottom right of the Claude or Codex window, where the
# model and effort menus are. Always on top, never takes the focus. Started by the Jev prompt
# hook (src/jev-hook.ts, showBadge) with -Spec: a UTF-8 JSON file {id, app, level, mode, title,
# body, how, seconds, hookPid, state}, so no text passes through a command line.
# - "Wie?" opens one sentence on where to switch.
# - mode "wait": the message waits for the switch; "So senden" sends it as it is (writes
#   badge-send.json). The hook then sets state done / sent / held and the figure follows.
# - Reports that it is on screen in badge-ack.json, refreshed about once a second.
# - Closes when a newer figure rewrites the spec, when the waiting hook is gone, or on time.
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
# Small JSON files next to the spec, UTF-8 without BOM (the hook reads them with JSON.parse).
function Write-JevFile([string]$name, [hashtable]$value) {
  if (-not $Spec) { return }
  try { [System.IO.File]::WriteAllText((Join-Path (Split-Path -LiteralPath $Spec) $name), ($value | ConvertTo-Json -Compress)) } catch { Write-JevLog "write $name failed: $_" }
}
function Send-JevAck { Write-JevFile 'badge-ack.json' @{ id = $Id; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
$ErrorActionPreference = 'Stop'
$Mode = 'note'; $How = ''; $HookPid = 0
$s = Read-JevSpec
if ($s) {
  if ($s.app -in 'claude', 'codex') { $App = $s.app }
  if ($s.level -in 'note', 'stop') { $Level = $s.level }
  if ($s.mode -eq 'wait') { $Mode = 'wait' }
  $Title = [string]$s.title; $Body = [string]$s.body; $Id = [string]$s.id; $How = [string]$s.how
  if ($s.seconds -gt 0) { $Seconds = [int]$s.seconds }
  if ($s.hookPid -gt 0) { $HookPid = [int]$s.hookPid }
}
Write-JevLog "start app=$App level=$Level mode=$Mode"
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
        WindowStartupLocation="Manual" Opacity="0">
  <Border x:Name="Card" Margin="10" CornerRadius="14" Background="#F21B1B1F" BorderBrush="$accent" BorderThickness="1.5" Padding="12,10,12,10">
    <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="2" Opacity="0.5"/></Border.Effect>
    <StackPanel Orientation="Horizontal">
      <Grid Width="36" Height="36" VerticalAlignment="Top" Margin="0,0,10,0">
        <Ellipse x:Name="Dot" Fill="$accent"/>
        <TextBlock Text="J" FontFamily="Segoe UI" FontWeight="Bold" FontSize="19" Foreground="#1B1B1F" HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Grid>
      <StackPanel MaxWidth="290" VerticalAlignment="Center">
        <TextBlock x:Name="TitleText" FontFamily="Segoe UI" FontSize="14.5" FontWeight="SemiBold" Foreground="White" TextWrapping="Wrap"/>
        <TextBlock x:Name="BodyText" FontFamily="Segoe UI" FontSize="12.5" Foreground="#CFCFD6" TextWrapping="Wrap" Margin="0,3,0,0"/>
        <TextBlock x:Name="HowText" FontFamily="Segoe UI" FontSize="12.5" Foreground="White" TextWrapping="Wrap" Margin="0,6,0,0" Visibility="Collapsed"/>
        <StackPanel x:Name="Actions" Orientation="Horizontal" Margin="0,6,0,0">
          <TextBlock x:Name="HowLink" Text="Wie?" FontFamily="Segoe UI" FontSize="12.5" FontWeight="SemiBold" Foreground="$accent" Background="Transparent" Cursor="Hand" Padding="0,2,14,2"/>
          <TextBlock x:Name="SendLink" Text="So senden" FontFamily="Segoe UI" FontSize="12.5" FontWeight="SemiBold" Foreground="#CFCFD6" Background="Transparent" Cursor="Hand" Padding="0,2,4,2" Visibility="Collapsed"/>
        </StackPanel>
      </StackPanel>
      <TextBlock x:Name="Arrow" Text="&#x2198;" FontFamily="Segoe UI Symbol" FontSize="24" Foreground="$accent" VerticalAlignment="Bottom" Margin="10,0,0,-6"/>
    </StackPanel>
  </Border>
</Window>
"@
$script:window = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
function Get-JevPart([string]$name) { $script:window.FindName($name) }
# Text is set as properties, never parsed as XAML.
(Get-JevPart 'TitleText').Text = $Title
(Get-JevPart 'BodyText').Text = $Body
(Get-JevPart 'HowText').Text = $How
if (-not $How) { (Get-JevPart 'HowLink').Visibility = 'Collapsed' }
if ($Mode -eq 'wait') { (Get-JevPart 'SendLink').Visibility = 'Visible' }
if (-not $How -and $Mode -ne 'wait') { (Get-JevPart 'Actions').Visibility = 'Collapsed' }
$script:state = 'open'
$script:closeAt = $null
$script:loaded = $false

function Set-JevPosition {
  $script:window.Left = $script:rect.Right / $script:scale - $script:window.ActualWidth - 12
  $script:window.Top = $script:rect.Bottom / $script:scale - $script:window.ActualHeight - 64
}
function Set-JevAccent([string]$hex) {
  $brush = (New-Object System.Windows.Media.BrushConverter).ConvertFromString($hex)
  (Get-JevPart 'Card').BorderBrush = $brush; (Get-JevPart 'Dot').Fill = $brush; (Get-JevPart 'Arrow').Foreground = $brush
}
function Set-JevDone([string]$hex, [string]$title, [string]$body, [double]$closeInSeconds) {
  if ($hex) { Set-JevAccent $hex }
  if ($title) { (Get-JevPart 'TitleText').Text = $title }
  (Get-JevPart 'BodyText').Text = $body
  (Get-JevPart 'HowText').Visibility = 'Collapsed'; (Get-JevPart 'Actions').Visibility = 'Collapsed'
  $script:closeAt = (Get-Date).AddSeconds($closeInSeconds)
}
# The hook's verdict: done (switched, the message runs), sent (as it is), held.
function Set-JevState([string]$state, $spec) {
  $script:state = $state
  Write-JevLog "state $state"
  switch ($state) {
    'done' { Set-JevDone '#30A46C' ([string]$spec.title) ([string]$spec.body) 2.5 }
    'sent' { $script:closeAt = (Get-Date).AddMilliseconds(300) }
    'held' { Set-JevDone '#E5484D' ([string]$spec.title) ([string]$spec.body) 6 }
  }
}

$script:window.Add_SourceInitialized({
  # WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW: never take the focus, never show in Alt+Tab.
  $h = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
  $ex = [JevFigure.Native]::GetWindowLong($h, -20)
  [void][JevFigure.Native]::SetWindowLong($h, -20, ($ex -bor 0x08000000 -bor 0x00000080))
})
$script:window.Add_Loaded({
  Set-JevPosition
  $script:loaded = $true
  $fade = New-Object System.Windows.Media.Animation.DoubleAnimation 0, 1, ([TimeSpan]::FromMilliseconds(220))
  $script:window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
  $own = (New-Object System.Windows.Interop.WindowInteropHelper $script:window).Handle
  if (-not [JevFigure.Native]::IsWindowVisible($own)) { [void][JevFigure.Native]::ShowWindow($own, 4) }  # SW_SHOWNOACTIVATE: a hidden start (STARTUPINFO) must not hide the figure
  Send-JevAck
  Write-JevLog "win32 visible=$([JevFigure.Native]::IsWindowVisible($own)) shown left=$($script:window.Left) top=$($script:window.Top) size=$($script:window.ActualWidth)x$($script:window.ActualHeight) visible=$($script:window.IsVisible)"
})
# "Wie?" makes the figure taller: keep its bottom-right corner where it was.
$script:window.Add_SizeChanged({ if ($script:loaded) { Set-JevPosition } })
(Get-JevPart 'HowLink').Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  $how = Get-JevPart 'HowText'
  $how.Visibility = if ($how.Visibility -eq 'Visible') { 'Collapsed' } else { 'Visible' }
})
(Get-JevPart 'SendLink').Add_MouseLeftButtonUp({
  param($sender, $e)
  $e.Handled = $true
  if ($script:state -ne 'open') { return }
  Write-JevFile 'badge-send.json' @{ id = $Id }
  Write-JevLog 'send as is'
  $script:state = 'sending'
  Set-JevDone '' '' 'Wird so gesendet …' 3
})
# A click elsewhere closes the figure, except while a message waits for it.
$script:window.Add_MouseLeftButtonUp({ if ($Mode -ne 'wait' -or $script:state -ne 'open') { $script:window.Close() } })
$script:window.Add_Closed({ [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })

$script:started = Get-Date
$script:ticks = 0
$script:timer = New-Object System.Windows.Threading.DispatcherTimer
$script:timer.Interval = [TimeSpan]::FromMilliseconds(300)
$script:timer.Add_Tick({
  $script:ticks++
  $now = $null; $readable = $true
  if ($Id) { try { $now = Read-JevSpec } catch { $readable = $false } }
  # A newer figure rewrote the spec (or it is gone): this one is done.
  if ($Id -and $readable -and (-not $now -or [string]$now.id -ne $Id)) { $script:timer.Stop(); $script:window.Close(); return }
  if ($now -and $now.state -and [string]$now.state -ne 'open' -and $script:state -in 'open', 'sending') { Set-JevState ([string]$now.state) $now }
  if ($script:ticks % 3 -eq 0 -and $script:state -in 'open', 'sending') { Send-JevAck }
  # The waiting hook is gone (message stopped in the app): nothing waits any more.
  if ($Mode -eq 'wait' -and $script:state -eq 'open' -and $HookPid -gt 0 -and -not (Get-Process -Id $HookPid -ErrorAction SilentlyContinue)) { $script:timer.Stop(); $script:window.Close(); return }
  if (($script:closeAt -and (Get-Date) -ge $script:closeAt) -or ((Get-Date) - $script:started).TotalSeconds -ge $Seconds) { $script:timer.Stop(); $script:window.Close() }
})
$script:timer.Start()
$script:window.Show()
[System.Windows.Threading.Dispatcher]::Run()
