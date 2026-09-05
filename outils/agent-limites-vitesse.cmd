@echo off
REM ---------------------------------------------------------------------------
REM Lanceur de l'agent de rattrapage des limites de vitesse.
REM
REM Appele par la tache planifiee "VizyoTracky-LimitesVitesse" CINQ fois par
REM jour : 04:30, 08:30, 14:00, 18:30 et 22:00 (declencheurs releves sur le
REM Planificateur le 2026-09-05 ; le catalogue des taches de fond annonce les
REM memes creneaux). L'agent travaille au plus 110 minutes (--minutes=110) puis
REM rend la main : le passage suivant reprend exactement la ou il s'est arrete
REM (il redemande a la base les cellules encore absentes du cache). Quand il
REM n'y a plus rien a resoudre, il sort aussitot — et ce passage compte comme
REM REUSSI (design/C3, point 3), pas comme une panne.
REM
REM Aucun credit d'API n'est consomme : Overpass / OpenStreetMap est gratuit.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0agent-limites-vitesse.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0agent-limites-vitesse.log"
"C:\Program Files\nodejs\node.exe" --max-old-space-size=6144 "%~dp0agent-limites-vitesse.cjs" --minutes=110 >> "%~dp0agent-limites-vitesse.log" 2>&1
exit /b %ERRORLEVEL%
