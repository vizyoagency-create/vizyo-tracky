# Dossier `docs/prompts/`

Ce dossier contient les prompts et guides d'exécution pour le développement séquentiel de Tracky.

## Ordre d'exécution

1. **`vague-a.md`** — Prompt Claude Code pour Phase 8 (logs) + Phase 6 (commands console). **Démarrer ici.**
2. **`bench-403c.md`** — Guide manuel pour le bench hardware 403C. À exécuter toi-même, pas dans Claude Code.
3. **`vague-b.md`** — Prompt Claude Code pour Phase 7 (SMS). À lancer après bench validé.

## Règles d'usage

- **Un seul prompt à la fois.** Ne jamais lancer Vague B avant Vague A mergée et bench validé.
- **Copier-coller le contenu EXACT** du bloc de code dans Claude Code, sans altération.
- **Mettre à jour `docs/EXECUTION-TRACKER.md`** après chaque retour de session.
- Si une session pose une question non anticipée : répondre dans le chat Claude Code, puis logger la décision dans `EXECUTION-TRACKER.md` section "Décisions prises".

## En cas de problème

- Session Claude Code qui dérape → arrêter immédiatement, logger dans "Issues ouvertes"
- Tests qui cassent → revert le commit fautif, ne pas accumuler la dette
- Divergence 403C imprévue → noter dans `bench-403c-report.md`, ajuster Vague B si impact SMS
