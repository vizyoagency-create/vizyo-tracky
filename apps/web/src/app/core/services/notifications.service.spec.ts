import { decidePushSync } from './notifications.service';

/**
 * QUE FAIRE AU CHARGEMENT POUR QUE LE SERVEUR CONNAISSE CET APPAREIL.
 *
 * ── Le défaut que ces tests verrouillent (2026-07-28) ────────────────────────────────
 * `isSubscribed()` ne consulte QUE le navigateur (`pushManager.getSubscription`). Le
 * serveur n'a jamais son mot à dire. Tant que les deux sont d'accord, personne ne le
 * remarque — mais ils peuvent diverger : purge d'administration de la table des
 * abonnements, restauration de sauvegarde, compte recréé.
 *
 * Quand c'est le cas, l'ancienne logique produisait un angle mort PARFAIT :
 *   - le navigateur a un abonnement → pas de ré-abonnement silencieux ;
 *   - le bandeau d'invitation ne s'affiche pas non plus (même condition) ;
 *   - l'écran de réglages affiche « abonné » ;
 *   - et le serveur ne connaît plus l'appareil → plus AUCUN push, définitivement.
 *
 * Rien n'échoue, rien ne s'affiche, rien ne se répare. C'est exactement la famille de
 * bugs que tout ce chantier de notifications existe pour supprimer.
 *
 * ── La contrainte de l'utilisateur ───────────────────────────────────────────────────
 * « Pas de redondance dans la demande de permission. » Aucune branche ci-dessous ne
 * déclenche de dialogue d'autorisation : on ne redemande jamais ce qui est déjà accordé,
 * et on ne demande jamais sans geste explicite (bouton « Activer »). Les navigateurs
 * refusent définitivement après quelques rejets — une demande de trop est irréversible.
 */
describe('decidePushSync', () => {
  it('⚠️ navigateur abonné → on REDÉCLARE quand même (le serveur a pu perdre sa ligne)', () => {
    // LE test du correctif. Avant, ce cas ne faisait rien du tout.
    expect(decidePushSync({ hasLocalSubscription: true, permission: 'granted' })).toBe('reassert');
  });

  it('navigateur sans abonnement mais autorisation accordée → ré-abonnement silencieux', () => {
    // Cas iOS : révocation silencieuse après ~2 semaines d'inactivité.
    expect(decidePushSync({ hasLocalSubscription: false, permission: 'granted' })).toBe('resubscribe');
  });

  it('autorisation refusée → on ne fait RIEN (surtout pas redemander)', () => {
    expect(decidePushSync({ hasLocalSubscription: false, permission: 'denied' })).toBe('none');
  });

  it('autorisation jamais demandée → on attend le geste de l’utilisateur', () => {
    // `default` = l'utilisateur n'a jamais tranché. C'est au bouton « Activer » de
    // demander, depuis un handler de clic — pas au chargement de l'application.
    expect(decidePushSync({ hasLocalSubscription: false, permission: 'default' })).toBe('none');
  });

  it('navigateur sans push → rien à tenter', () => {
    expect(decidePushSync({ hasLocalSubscription: false, permission: 'unsupported' })).toBe('none');
  });

  it('un abonnement local l’emporte sur TOUTE valeur d’autorisation', () => {
    // Cohérence de la règle : si le navigateur détient un abonnement, il est par
    // construction autorisé. Une lecture d'autorisation qui dirait le contraire est
    // une incohérence de l'environnement, pas une raison de ne rien faire — et surtout
    // pas une raison de redemander l'autorisation.
    for (const permission of ['granted', 'denied', 'default', 'unsupported'] as const) {
      expect(decidePushSync({ hasLocalSubscription: true, permission })).toBe('reassert');
    }
  });
});
