@echo off
REM ---------------------------------------------------------------------------
REM COURRIER IA — porte les travaux prepares par le serveur (rapport d'activite,
REM analyse de lieux) vers le modele, via l'abonnement Claude Code du poste.
REM Aucun credit d'API. La file vide = sortie immediate : la tache quotidienne
REM est un no-op les jours sans travaux (design/C1-TRAVAUX-IA-LOCAUX.md).
REM
REM Porte par le Planificateur de Windows : survit aux fermetures de session et
REM aux redemarrages — trois pertes en deux jours ont paye cette lecon.
REM
REM Depuis le 2026-09-05 (design/C3, point 3) l'agent verifie D'ABORD qu'il est
REM sur l'abonnement (claude auth status = claude.ai, aucune ANTHROPIC_API_KEY
REM dans l'environnement) : sinon il refuse tout travail, journalise un passage
REM en echec explicite et sort avec le code 2. Ne jamais poser de cle IA dans
REM le .env racine (repertoire de travail ci-dessous) : elles vivent dans
REM apps/api/.env.
REM ---------------------------------------------------------------------------
cd /d "%~dp0.."
echo. >> "%~dp0agent-courrier-ia.log"
echo ===== %DATE% %TIME% ===== >> "%~dp0agent-courrier-ia.log"
"C:\Program Files\nodejs\node.exe" "%~dp0agent-courrier-ia.cjs" --minutes=30 >> "%~dp0agent-courrier-ia.log" 2>&1
exit /b %ERRORLEVEL%
