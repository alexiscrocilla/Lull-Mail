# Waits for the Lull Mail server to accept connections, then opens
# the URL in the default browser. Invoked in parallel by start.bat.

$Url        = if ($args.Count -ge 1) { $args[0] } else { 'http://localhost:8000' }
$TimeoutSec = 60     # total wait budget
$IntervalMs = 400    # poll every 0.4 s

# Extract host:port from URL for a low-overhead TCP probe (much faster
# than Invoke-WebRequest, which spins up IE-style proxy detection on
# first call and easily blows a 2 s timeout).
$uri  = [Uri]$Url
$host_ = $uri.Host
$port  = if ($uri.Port -gt 0) { $uri.Port } else { if ($uri.Scheme -eq 'https') { 443 } else { 80 } }

$deadline = (Get-Date).AddSeconds($TimeoutSec)

while ((Get-Date) -lt $deadline) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($host_, $port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(800) -and $client.Connected) {
            $client.EndConnect($iar)
            $client.Close()
            Start-Process $Url
            exit 0
        }
    } catch {
        # Connection refused or transient — keep polling.
    } finally {
        $client.Close()
    }
    Start-Sleep -Milliseconds $IntervalMs
}

# Server never came up in time — open anyway so the user sees something.
Start-Process $Url
exit 1
