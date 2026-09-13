<#
.SYNOPSIS
  Les cinq taches planifiees des agents du poste : constat, et mise en conformite (T36, 2026-09-13).

.DESCRIPTION
  Sans option, le script CONSTATE et ne change rien : pour chaque tache, l'action reelle, la limite
  d'execution, et si elles sont celles attendues. Avec -Appliquer, il pointe l'action sur le
  lanceur sans fenetre (outils\lancer-sans-fenetre.js) et pose la limite d'execution attendue.
  Declencheurs, principal (session interactive), anti-chevauchement : intouches.

  POURQUOI. Les taches lancaient chaque .cmd directement : une console VISIBLE prenait le focus a
  chaque passage, et un Ctrl-C tape a ce moment tuait l'agent (33 marques ^C au 13/09, quatre
  passages morts le seul 13/09, code 0xC000013A). Et la limite du rattrapage (1 h 15) etait sous
  le budget de l'agent (100 min) : le Planificateur tuait le passage avant sa propre fin.

  Les limites sont le budget de l'agent plus une marge : un passage qui pend (ssh fige, CLI muette)
  doit finir par lacher la tache, sinon IgnoreNew bloque tous les passages suivants.

    powershell -NoProfile -ExecutionPolicy Bypass -File outils\taches-planifiees.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File outils\taches-planifiees.ps1 -Appliquer
#>
param([switch]$Appliquer)

$ErrorActionPreference = 'Stop'
$outils = Split-Path -Parent $MyInvocation.MyCommand.Path
$lanceur = Join-Path $outils 'lancer-sans-fenetre.js'
if (-not (Test-Path $lanceur)) { throw "Lanceur introuvable : $lanceur" }
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

# Budget de chaque agent (dans son .cmd) + marge : CourrierIA 30 min, LimitesVitesse et RecitTrajet
# 110 min, QualiteGPS calcul pur, RattrapageRecits 100 min.
$TACHES = @(
  @{ Nom = 'VizyoTracky-RecitTrajet';      Script = 'agent-recit-trajet.cmd';   Limite = 'PT2H' },
  @{ Nom = 'VizyoTracky-RattrapageRecits'; Script = 'rattrapage-recits.cmd';    Limite = 'PT1H50M' },
  @{ Nom = 'VizyoTracky-CourrierIA';       Script = 'agent-courrier-ia.cmd';    Limite = 'PT35M' },
  @{ Nom = 'VizyoTracky-LimitesVitesse';   Script = 'agent-limites-vitesse.cmd'; Limite = 'PT2H' },
  @{ Nom = 'VizyoTracky-QualiteGPS';       Script = 'agent-qualite-gps.cmd';    Limite = 'PT2H' }
)

$ecarts = 0
foreach ($d in $TACHES) {
  $t = Get-ScheduledTask -TaskName $d.Nom -ErrorAction SilentlyContinue
  if (-not $t) { Write-Output ("{0,-32} ABSENTE" -f $d.Nom); $ecarts++; continue }

  $script = Join-Path $outils $d.Script
  $argsAttendus = '//B //Nologo "{0}" "{1}"' -f $lanceur, $script
  $a = $t.Actions[0]
  $actionOk = ($a.Execute -ieq $wscript -or $a.Execute -ieq 'wscript.exe') -and ($a.Arguments -eq $argsAttendus)
  $limiteOk = ($t.Settings.ExecutionTimeLimit -eq $d.Limite)
  $etat = if ($actionOk -and $limiteOk) { 'conforme' } else { 'A CORRIGER' }
  if (-not ($actionOk -and $limiteOk)) { $ecarts++ }

  Write-Output ("{0,-32} {1,-11} action={2} limite={3} (attendue {4}) {5}" -f $d.Nom, $etat,
    $(if ($actionOk) { 'sans fenetre' } else { 'FENETRE VISIBLE : ' + $a.Execute }),
    $t.Settings.ExecutionTimeLimit, $d.Limite, $t.State)

  if (-not $Appliquer) { continue }
  if (-not $actionOk) {
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $argsAttendus -WorkingDirectory $outils
    Set-ScheduledTask -TaskName $d.Nom -Action $action | Out-Null
    Write-Output ("{0,-32}   -> action pointee sur le lanceur sans fenetre" -f '')
  }
  if (-not $limiteOk) {
    $s = $t.Settings
    $s.ExecutionTimeLimit = $d.Limite
    Set-ScheduledTask -TaskName $d.Nom -Settings $s | Out-Null
    Write-Output ("{0,-32}   -> limite d'execution {1}" -f '', $d.Limite)
  }
}

if ($Appliquer) { Write-Output ''; Write-Output 'Relecture :'; & $MyInvocation.MyCommand.Path; exit $LASTEXITCODE }
exit $(if ($ecarts) { 1 } else { 0 })
