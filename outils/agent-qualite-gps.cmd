@echo off
REM ---------------------------------------------------------------------------
REM Lanceur de l'agent de qualite GPS (zones mortes).
REM
REM Appele par la tache planifiee "VizyoTracky-QualiteGPS", une fois par nuit a
REM 05:00. Pourquoi 05:00 et pas 03:15 : l'agent de recit occupe deja cette
REM tranche et peut courir jusqu'a 110 minutes. Deux agents sur le meme poste
REM au meme moment ne serviraient personne.
REM
REM AUCUN modele n'est appele : le diagnostic est un calcul geometrique. Cet
REM agent ne consomme donc ni credits d'API, ni quota d'abonnement, et n'a
REM besoin d'AUCUNE session Claude Code ouverte — contrairement a l'agent de
REM recit. Il lui faut seulement l'acces SSH au VPS.
REM
REM Il ecrit une ligne de passage a chaque fois, MEME quand il ne trouve rien :
REM une nuit sans rien a signaler est un bon resultat, pas une panne, et la page
REM des taches de fond doit pouvoir faire la difference.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0agent-qualite-gps.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0agent-qualite-gps.log"
"C:\Program Files\nodejs\node.exe" "%~dp0agent-qualite-gps.cjs" >> "%~dp0agent-qualite-gps.log" 2>&1
exit /b %ERRORLEVEL%
