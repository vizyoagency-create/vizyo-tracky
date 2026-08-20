@echo off
REM ---------------------------------------------------------------------------
REM RATTRAPAGE des recits de trajet — l'HISTORIQUE, pas le courant.
REM
REM Distinct de `agent-recit-trajet.cmd`, qui ne couvre que les 48 dernieres
REM heures et tourne une fois par nuit. Celui-ci ouvre la fenetre a 1 500 h pour
REM resorber l'arriere, et disparait de lui-meme : l'agent sort immediatement
REM quand il n'y a plus rien a narrer, donc la tache devient un no-op.
REM
REM ── POURQUOI UNE TACHE PLANIFIEE ET PAS UN LANCEMENT MANUEL ────────────────
REM
REM Le 2026-08-20/21, le rattrapage a ete perdu TROIS fois : un redemarrage du
REM poste, puis deux arrets de la session Claude. A chaque fois l'agent avait ete
REM lance depuis cette session, donc il mourait avec elle.
REM
REM Ici c'est le service Planificateur de taches de Windows qui porte le
REM processus. Il survit a la fermeture de la session, au crash de l'outil qui
REM l'a demarre, et il est relance apres un redemarrage.
REM
REM Aucun credit d'API : le travail passe par l'abonnement Claude Code du poste.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0rattrapage-recits.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0rattrapage-recits.log"
"C:\Program Files\nodejs\node.exe" "%~dp0agent-recit-trajet.cjs" --heures=1500 --minutes=70 --lot=10 >> "%~dp0rattrapage-recits.log" 2>&1
exit /b %ERRORLEVEL%
