// ---------------------------------------------------------------------------
// LANCEUR SANS FENETRE des agents du poste — JScript pour wscript.exe (T36, 2026-09-13).
//
//     wscript.exe //B //Nologo "outils\lancer-sans-fenetre.js" "outils\<agent>.cmd"
//
// ── POURQUOI ────────────────────────────────────────────────────────────────
//
// Le Planificateur lancait chaque .cmd directement, en session interactive :
// une fenetre de console VISIBLE s'ouvrait a chaque passage et prenait le
// focus. Un Ctrl-C tape a ce moment (copier un texte…) tombait dedans et
// tuait node — 33 marques ^C dans les journaux des agents au 13/09, quatre
// passages morts le seul 13/09, code de sortie 0xC000013A au Planificateur.
//
// wscript.exe n'a pas de console. Il lance le .cmd avec le style de fenetre 0
// (SW_HIDE) : la console existe — cd, %~dp0 et les redirections vers le
// journal marchent —, mais sans fenetre, donc sans focus, donc sans clavier.
//
// ── CE QUI EST PRESERVE ────────────────────────────────────────────────────
//
// `Run(…, 0, true)` ATTEND la fin du .cmd et rend son code de sortie, que
// WScript.Quit transmet au Planificateur. Le passage est donc « en cours »
// aux yeux du Planificateur tout le temps qu'il tourne : l'anti-chevauchement
// (IgnoreNew) et la limite d'execution gardent leur sens, et le dernier
// resultat de la tache reste celui de l'agent.
//
// ── POURQUOI JSCRIPT ET PAS VBSCRIPT NI POWERSHELL ─────────────────────────
//
// VBScript est en cours de retrait de Windows ; JScript sous WSH ne l'est pas.
// PowerShell -WindowStyle Hidden ouvre sa fenetre AVANT de la cacher : le
// quart de seconde ou elle a le focus suffit a un Ctrl-C.
// ---------------------------------------------------------------------------
var args = WScript.Arguments;
// Pas de message : sous wscript.exe il n'y a ni console ni StdErr. Le code 2 dit « mal appele ».
if (args.length < 1) WScript.Quit(2);

// cmd.exe /d (sans AutoRun) /c ""<chemin>"" : la paire de guillemets externe est
// retiree par cmd, il reste "<chemin>" — robuste aux espaces dans le chemin.
var ligne = 'cmd.exe /d /c ""' + args(0) + '""';
var shell = new ActiveXObject('WScript.Shell');
WScript.Quit(shell.Run(ligne, 0, true));
