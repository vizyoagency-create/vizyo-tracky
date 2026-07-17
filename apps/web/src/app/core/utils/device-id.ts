const DEVICE_ID_KEY = 'tracky.device.id';

/**
 * Identifiant d'appareil stable (localStorage) — la MÊME clé que celle des
 * abonnements push (notifications.service). Partagé pour que « appareil de
 * confiance » (vérification e-mail) et « device push » désignent le même device.
 * Best-effort : sur iOS Safari le localStorage peut être purgé (~7 jours) → un
 * nouvel id est régénéré (l'appareil sera re-challengé, ce qui est acceptable).
 */
export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[0-9a-f-]{8,64}$/i.test(existing)) return existing;
    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
