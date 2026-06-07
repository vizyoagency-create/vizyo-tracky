import { SIM_STATUS, simStatusCategory, type SimStatusCategory } from '@vizyo/tracky-shared';

/** Classe CSS de badge par categorie de statut (cf. styles des composants). */
export const SIM_BADGE_CLASS: Record<SimStatusCategory, string> = {
  active: 'st-active',
  suspended: 'st-suspended',
  pending: 'st-pending',
  inactive: 'st-inactive',
  unknown: 'st-unknown',
};

export function simBadgeClass(statusId: number | null | undefined): string {
  return SIM_BADGE_CLASS[simStatusCategory(statusId)];
}

/** Actions de cycle de vie proposees au SUPER_ADMIN (le provider valide la transition). */
export const SIM_STATUS_ACTIONS: { statusId: number; label: string; danger?: boolean }[] = [
  { statusId: SIM_STATUS.ACTIVATED, label: 'Activer' },
  { statusId: SIM_STATUS.SUSPENDED, label: 'Suspendre' },
  { statusId: SIM_STATUS.DEACTIVATED, label: 'Désactiver' },
  { statusId: SIM_STATUS.RETIRED, label: 'Résilier', danger: true },
];

/** Octets -> "1,2 Go" / "340 Mo" / "0". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes <= 0) return '0';
  const mo = bytes / 1_000_000;
  if (mo < 1) return `${Math.round(bytes / 1000)} Ko`;
  if (mo < 1000) return `${mo < 10 ? mo.toFixed(1) : Math.round(mo)} Mo`;
  return `${(mo / 1000).toFixed(mo / 1000 < 10 ? 1 : 0)} Go`;
}

/** Limite data : 0/null = illimite. */
export function formatDataLimit(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return 'Illimité';
  return formatBytes(bytes);
}

/** % de conso vs limite (0 si illimite/inconnu). Cap a 100 pour la barre. */
export function dataPercent(
  volume: number | null | undefined,
  limit: number | null | undefined,
): number {
  if (!limit || limit <= 0 || volume == null) return 0;
  return Math.min(100, Math.round((volume / limit) * 100));
}

export function formatDateFr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTimeFr(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
