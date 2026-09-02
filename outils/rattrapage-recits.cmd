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
REM ── FENETRE : TOUT L'HISTORIQUE CONSERVE, PAS 62 JOURS ────────────────────
REM
REM 1 500 h laissaient hors de portee tout trajet de plus de 62 jours : au
REM 2026-09-02, 552 analyses de mh cars et 205 d'A2R restaient sans recit pour
REM cette seule raison — des trajets qu'on conserve douze mois (retention des
REM trajets) mais qu'on ne mettait jamais en mots. Un recit n'a besoin que de
REM la ligne d'analyse, pas des positions GPS : rien n'empeche de le produire.
REM 9 000 h (~375 j) couvre la retention entiere. La tache reste un no-op des
REM qu'il n'y a plus rien a narrer.
REM
REM 100 min et non 70 : la tache passe toutes les 2 h, il reste 20 min de marge
REM avant la suivante, et l'anti-chevauchement du Planificateur fait le reste.
"C:\Program Files\nodejs\node.exe" "%~dp0agent-recit-trajet.cjs" --heures=9000 --minutes=100 --lot=10 >> "%~dp0rattrapage-recits.log" 2>&1
exit /b %ERRORLEVEL%
