@echo off
REM ---------------------------------------------------------------------------
REM Lanceur de l'agent de recit de trajet.
REM
REM Appele par la tache planifiee "VizyoTracky-RecitTrajet", une fois par nuit.
REM L'agent travaille au plus 110 minutes puis rend la main : le passage suivant
REM reprend la ou il s'est arrete (il redemande a la base les trajets encore sans
REM recit). Quand il n'y a plus rien, il sort aussitot.
REM
REM AUCUN credit d'API n'est consomme : le travail passe par l'abonnement Claude
REM Code du poste. En contrepartie il faut une session ouverte — si elle a expire,
REM l'agent s'arrete avec le code 3 et le dit dans ce journal.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0agent-recit-trajet.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0agent-recit-trajet.log"
"C:\Program Files\nodejs\node.exe" "%~dp0agent-recit-trajet.cjs" --minutes=110 >> "%~dp0agent-recit-trajet.log" 2>&1
exit /b %ERRORLEVEL%
