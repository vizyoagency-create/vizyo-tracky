import { Injectable } from '@nestjs/common';

/**
 * Boîtiers non reconnus (provisioning) — quand un boîtier Coban tente de se logger en GPRS
 * avec un IMEI qui n'existe pas dans la base, le serveur TCP ferme la connexion (`socket.end`).
 * Le boîtier retombe alors en SMS (spam de positions vers le téléphone admin). C'est la cause
 * #1 du "spam SMS" pendant le provisioning d'un parc : un IMEI mal saisi ou pas encore créé.
 *
 * Ce registre EN MÉMOIRE garde la trace de ces tentatives rejetées pour les exposer en admin
 * (vue "Boîtiers non reconnus" → créer le tracker en 1 clic). Pas de persistance volontaire :
 * un boîtier réémet toutes les ~30 s, donc la liste se reconstruit en moins d'1 min après un
 * restart, et une entrée disparaît dès que le tracker est enregistré + se connecte (forget()).
 */
export interface UnknownTrackerEntry {
  imei: string;
  firstSeenAt: string;
  lastSeenAt: string;
  attempts: number;
  lastRemoteAddr: string | null;
}

interface InternalEntry {
  imei: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  attempts: number;
  lastRemoteAddr: string | null;
}

@Injectable()
export class UnknownTrackerRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  /** Cap dur (anti-fuite mémoire si un scan balance des milliers d'IMEI). */
  private static readonly MAX_ENTRIES = 500;
  /** Fenêtre "actif" : on n'expose que les boîtiers vus récemment (= qui spamment encore). */
  private static readonly ACTIVE_WINDOW_MS = 15 * 60 * 1000;

  /** Enregistre une tentative de login d'un IMEI inconnu (appelé par le serveur TCP). */
  record(imei: string, remoteAddr: string | null | undefined): void {
    const now = new Date();
    const existing = this.entries.get(imei);
    if (existing) {
      existing.lastSeenAt = now;
      existing.attempts += 1;
      if (remoteAddr) existing.lastRemoteAddr = remoteAddr;
      return;
    }
    if (this.entries.size >= UnknownTrackerRegistry.MAX_ENTRIES) {
      // Évince l'entrée la moins récemment vue.
      let oldestImei: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.entries) {
        if (v.lastSeenAt.getTime() < oldestTime) {
          oldestTime = v.lastSeenAt.getTime();
          oldestImei = k;
        }
      }
      if (oldestImei) this.entries.delete(oldestImei);
    }
    this.entries.set(imei, {
      imei,
      firstSeenAt: now,
      lastSeenAt: now,
      attempts: 1,
      lastRemoteAddr: remoteAddr ?? null,
    });
  }

  /** Oublie un IMEI (appelé quand un tracker se connecte avec succès → plus "inconnu"). */
  forget(imei: string): void {
    this.entries.delete(imei);
  }

  /** IMEI inconnus VUS RÉCEMMENT (fenêtre active), triés par dernière tentative décroissante. */
  list(): UnknownTrackerEntry[] {
    const cutoff = Date.now() - UnknownTrackerRegistry.ACTIVE_WINDOW_MS;
    return [...this.entries.values()]
      .filter((e) => e.lastSeenAt.getTime() >= cutoff)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((e) => ({
        imei: e.imei,
        firstSeenAt: e.firstSeenAt.toISOString(),
        lastSeenAt: e.lastSeenAt.toISOString(),
        attempts: e.attempts,
        lastRemoteAddr: e.lastRemoteAddr,
      }));
  }
}
