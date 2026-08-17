<#
.SYNOPSIS
    Runs the Spendifre runtime self-test and reports the result.

.DESCRIPTION
    Calls GET /api/admin/self-test and prints each check. Exits non-zero when
    any check fails, so this works as a scheduled task, a monitoring probe, or
    a release gate without anyone having to parse the output.

    The checks are read-only. Nothing this script triggers writes anything
    except the audit event recording that a verification happened — which is
    the point: a verification you dare not run against production is not a
    verification.

    Authentication is a session cookie. There is no API key: the endpoint is
    behind the same Entra-derived authorisation as everything else, and adding
    a second credential path for convenience would be adding a second thing to
    steal. For unattended use, run this as a service account through the same
    sign-in flow a person uses.

.PARAMETER BaseUrl
    Origin of the deployment, e.g. https://spendifre.birgma.com

.PARAMETER SessionCookie
    Value of the __Host-sid cookie for an account holding `selftest.run`
    (Administrator or CFO). Read from the SPENDIFRE_SESSION environment
    variable when not supplied, so it never appears in a command line or a
    shell history.

.PARAMETER WarningsAsErrors
    Treat warnings as failures. Off by default: a warning is a thing to look
    at, and conflating it with a failure is how a monitor gets muted.

.PARAMETER Json
    Emit the raw report instead of the formatted table, for piping into
    something else.

.EXAMPLE
    $env:SPENDIFRE_SESSION = '...'
    ./Invoke-SpendifreSelfTest.ps1 -BaseUrl https://spendifre.birgma.com

.EXAMPLE
    # As a scheduled task, alerting only on failure.
    ./Invoke-SpendifreSelfTest.ps1 -BaseUrl $url -Json | Out-File selftest.json
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https?://')]
    [string] $BaseUrl,

    [string] $SessionCookie = $env:SPENDIFRE_SESSION,

    [switch] $WarningsAsErrors,

    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SessionCookie)) {
    Write-Error 'No session. Set SPENDIFRE_SESSION or pass -SessionCookie.'
    exit 2
}

# The cookie name depends on whether the deployment is served over TLS: the
# __Host- prefix is only valid over https, and the application picks the name
# accordingly. Matching that here means the script works against a local
# development instance as well as production.
$cookieName = if ($BaseUrl.StartsWith('https://')) { '__Host-sid' } else { 'sid' }

$uri = "$($BaseUrl.TrimEnd('/'))/api/admin/self-test"

try {
    $response = Invoke-RestMethod -Uri $uri -Method Get -Headers @{
        Cookie = "$cookieName=$SessionCookie"
        Accept = 'application/json'
    } -TimeoutSec 120
}
catch {
    $status = $null
    if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
        $status = [int] $_.Exception.Response.StatusCode
    }

    switch ($status) {
        401 { Write-Error 'Not authenticated. The session has expired — sign in again.' }
        403 { Write-Error 'This account does not hold selftest.run (Administrator or CFO).' }
        429 { Write-Error 'Rate limited. The self-test is capped at six runs per five minutes.' }
        default { Write-Error "Could not reach $uri : $($_.Exception.Message)" }
    }
    exit 2
}

if ($Json) {
    $response | ConvertTo-Json -Depth 6
}
else {
    Write-Host ''
    Write-Host "Spendifre self-test — region $($response.region), FY$($response.fiscalYear)"
    Write-Host "Started $($response.startedAt), took $($response.durationMs) ms"
    Write-Host ''

    foreach ($check in $response.checks) {
        # A glyph as well as a colour: this output ends up in logs and ticket
        # comments that carry no colour at all, and the same A11Y-001 reasoning
        # applies to a terminal as to the UI.
        $glyph, $colour = switch ($check.status) {
            'pass'    { '  OK  ', 'Green' }
            'warn'    { ' WARN ', 'Yellow' }
            'fail'    { ' FAIL ', 'Red' }
            'skipped' { ' SKIP ', 'DarkGray' }
            default   { '  ??  ', 'White' }
        }

        Write-Host "[$glyph] " -ForegroundColor $colour -NoNewline
        Write-Host "$($check.title)  " -NoNewline
        Write-Host "($($check.requirement))" -ForegroundColor DarkGray
        if ($check.status -ne 'pass') {
            Write-Host "         $($check.detail)" -ForegroundColor $colour
        }
    }

    Write-Host ''
    Write-Host ("{0} passed, {1} failed, {2} warnings, {3} skipped" -f `
        $response.summary.pass, $response.summary.fail,
        $response.summary.warn, $response.summary.skipped)
    Write-Host ''
}

# Exit code is the machine-readable answer, so a scheduler needs no parsing:
#   0  healthy
#   1  at least one check failed (or warned, with -WarningsAsErrors)
#   2  could not run the check at all — a different problem, and worth
#      distinguishing, because "the system is broken" and "we could not ask"
#      call for different responses.
if (-not $response.healthy) { exit 1 }
if ($WarningsAsErrors -and $response.summary.warn -gt 0) { exit 1 }
exit 0
