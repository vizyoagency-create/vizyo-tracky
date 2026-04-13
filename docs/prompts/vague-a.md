# Prompt Claude Code — Vague A (Phase 8 + Phase 6)

> Copier-coller ce prompt tel quel dans Claude Code, depuis la racine du monorepo Tracky.
> Mettre à jour `docs/EXECUTION-TRACKER.md` après le retour.

---

```
Mission : implémenter COMPLÈTEMENT les Phases 8 (logs) puis 6 (TCP commands console)
du projet Tracky, en un seul sprint, sans points de validation intermédiaires.
La Phase 5 (bench hardware 403C) est un test physique séparé, pas du code.
La Phase 7 (SMS) arrivera dans une Vague B ultérieure.

AVANT DE CODER : lire dans cet ordre

1. docs/EXECUTION-TRACKER.md (état et décisions figées)
2. docs/08-logging-and-observability.md
3. docs/06-tcp-commands-console.md
4. docs/03-protocol-coban-gps403d.md (spec protocole de référence)
5. docs/04-roadmap.md (état actuel du code)
6. packages/shared/src/protocol/ (parser + encoder + tests)
7. apps/api/src/tracker-tcp/, socket-registry/, engine-control/, realtime/
8. apps/api/prisma/schema.prisma
9. apps/web/src/app/features/engine-control/ (pattern UI à réutiliser)

DÉCISIONS ARCHITECTURE (figées, ne pas rediscuter)

- Scheduling : cron poll DB via @nestjs/schedule, PAS de BullMQ
- Catalog commandes : fichier unique packages/shared/src/protocol/coban.catalog.ts,
  SMS-only gérés par availableVia: ['sms']
- TrackerCommand : modèle Prisma NEUF, totalement séparé d'EngineControlCommand
- engine_stop / engine_resume : absents du catalog (commentaire explicatif pour
  éviter ajout par erreur), action exclusive via EngineControlButton
- Raw mode : textarea libre, SUPER_ADMIN only, placeholder avec 2 exemples
- Enum CommandStatus actuel : INCHANGÉ (reste pour EngineControl).
  Créer un NOUVEAU enum TrackerCommandStatus (PENDING, SCHEDULED, SENT,
  ACKNOWLEDGED, FAILED, CANCELLED) + TrackerCommandChannel (TCP, SMS)
- AckWaiter : hook dans case 'unknown' de dispatchFrame (PAS avant le parser position)

DÉCISIONS NAMING

- Module : TrackerCommandsModule
- Route REST : /tracker-commands
- WS event : tracker-command:updated
- UI tab nom : "Commandes"

DÉCISIONS UX

- Historique visible à DEUX endroits :
  1. Tab "Commandes" dans vehicle-detail (scope véhicule)
  2. Page /admin/commands (scope global, SUPER_ADMIN + FLEET_ADMIN leur flotte)
- BONUS : endpoint GET /vehicles/:id/commands-history qui merge
  EngineControlCommand + TrackerCommand en UNE timeline unifiée, discriminant
  type: 'engine' | 'tracker'. UI associée dans vehicle-detail.

LOGS — PHASE 8 EN PREMIER

Livre Phase 8 AVANT Phase 6. La Phase 6 doit dès sa conception utiliser
CobanWireLogger et ErrorLogger. Sans les logs, on ne pourra pas débugger
le bench 403C. Non-négociable.

ORDRE DE LIVRAISON STRICT

1. Phase 8 complète (logs + observability + admin UI)
   → tests verts
   → commit "feat(observability): pino logs, wire logger, error log persistence, admin UI"

2. Phase 6.1 — Catalog shared (20 templates, engine_stop/resume EXCLUS)
   → tests verts sur packages/shared
   → commit "feat(shared): coban command catalog with 20 templates"

3. Phase 6.2 — Prisma TrackerCommand + nouveau enum
   → migration générée et appliquée
   → commit "feat(api): tracker_commands prisma model and migration"

4. Phase 6.3 — AckWaiterService + hook TCP
   → tests verts incluant scénario ACK match + timeout + no-match passthrough
   → commit "feat(api): ack waiter service with tcp dispatch hook"

5. Phase 6.4 — TrackerCommandsService + Controller + DTOs + WS event
   → 15+ tests, utilise WireLogger pour chaque dispatch
   → commit "feat(api): tracker commands service and REST controller"

6. Phase 6.5 — Scheduling via cron poll DB
   → cron toutes les 30s, poll les SCHEDULED dont scheduledAt <= NOW()
   → tests verts
   → commit "feat(api): scheduled tracker commands via cron"

7. Phase 6.6 — Angular UI complète (builder, history, detail drawer, raw mode)
   → commit "feat(web): tracker commands panel and admin page"

8. BONUS — Endpoint commands-history unifié + UI timeline agrégée
   → commit "feat: unified vehicle commands history"

9. Mise à jour docs/04-roadmap.md et docs/EXECUTION-TRACKER.md
   → cases à cocher, commits loggés dans le journal
   → commit "docs: update roadmap with phase 8 and 6 completion"

CONTRAINTES PERMANENTES

- TypeScript strict, zéro any non justifié
- Angular : standalone + signals, Tailwind 4, pas de NgModule
- NestJS : modules isolés, tests co-localisés, pas de dépendances circulaires
- Prisma 7 avec @prisma/adapter-pg (PAS datasourceUrl)
- NE JAMAIS toucher EngineControlModule sauf pour l'endpoint commands-history
  (qui lit seulement la table, ne la modifie pas)
- NE JAMAIS installer une lib autre que : nestjs-pino, pino, pino-http,
  pino-pretty (Phase 8) — pour Phase 6 aucune lib nouvelle
- Labels UI en français, code et commits en anglais
- Chaque commit doit être auto-suffisant et build vert
- Tests existants (55+ API, 42 shared) doivent rester verts à chaque commit

LOGS CRITIQUES À CAPTURER (vérifier que ces 8 cas produisent des logs utiles)

1. Tracker 403C se connecte → log INFO avec imei, remoteAddr, frameRaw du login
2. Tracker envoie position → log DEBUG avec imei, lat, lng, speed, valid
3. Commande envoyée → log INFO avec commandId, imei, templateId, payload
4. ACK reçu → log INFO avec commandId, imei, rawAck, latencyMs
5. ACK timeout → log WARN avec commandId, imei, expectedPattern, elapsedMs
6. Erreur parsing frame → log ERROR + ErrorLog row + context raw frame
7. Socket fermé inattendu → log WARN avec imei, reason
8. Exception controller → AllExceptionsFilter crée ErrorLog + retourne requestId client

LIVRAISON FINALE

À la fin, produis un SEUL message récap avec :
- Liste des commits dans l'ordre avec hash court
- Nombre de tests ajoutés par module
- Captures d'écran texte des logs JSON pour les 8 cas ci-dessus (copie-colle
  du terminal, pas des mocks)
- Checklist Phase 8 et Phase 6 dans EXECUTION-TRACKER.md mise à jour (cases ✅)
- Points d'attention pour le bench 403C (qu'est-ce qui pourrait mal tourner
  côté code qu'on ne pourrait pas prédire sans hardware)

Si tu rencontres une contradiction entre la roadmap et le code existant qui n'est
PAS couverte par les décisions ci-dessus, STOP et pose-moi la question dans le
chat AVANT de coder. Sinon, exécute tout d'une traite.

GO.
```

---

## Après le retour de Claude Code

1. Pull/review la branche
2. Valider que `pnpm test` est vert côté api ET shared
3. Lancer `pnpm dev` et tester manuellement sur le mock :
   - Envoyer une commande `status` → vérifier logs + history
   - Envoyer une commande dangereuse (reset) → vérifier double confirm + logs
   - Planifier une commande dans 2 min → vérifier dispatch automatique
   - Consulter `/admin/observability` → 3 tabs fonctionnels
4. Merger sur main
5. Mettre à jour `docs/EXECUTION-TRACKER.md` :
   - Cases Phase 8 ✅
   - Cases Phase 6 ✅
   - Progress bar Vague A → 100 %
   - Ligne dans le journal des sessions
6. Passer au bench 403C avec `docs/prompts/bench-403c.md`
