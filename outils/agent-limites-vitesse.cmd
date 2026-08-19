@echo off
REM ---------------------------------------------------------------------------
REM Lanceur de l'agent de rattrapage des limites de vitesse.
REM
REM Appele par la tache planifiee "VizyoTracky-LimitesVitesse" toutes les heures.
REM L'agent travaille 50 minutes puis rend la main : la tache suivante reprend
REM exactement la ou il s'est arrete (il redemande a la base les cellules encore
REM absentes du cache). Quand il n'y a plus rien a resoudre, il sort aussitot.
REM
REM Aucun credit d'API n'est consomme : Overpass / OpenStreetMap est gratuit.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0agent-limites-vitesse.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0agent-limites-vitesse.log"
"C:\Program Files\nodejs\node.exe" "%~dp0agent-limites-vitesse.cjs" --minutes=110 >> "%~dp0agent-limites-vitesse.log" 2>&1
exit /b %ERRORLEVEL%
