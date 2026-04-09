/**
 * Stub de parser Coban GPS403D.
 *
 * Les trames réelles ressemblent à : *HQ,<imei>,V1,...#
 * TODO: compléter avec la doc constructeur.
 */
export interface ParsedCobanFrame {
  raw: string;
  imei: string | null;
  type: string | null;
}

export function parseCobanFrame(raw: string): ParsedCobanFrame {
  const cleaned = raw.trim().replace(/^\*|#$/g, '');
  const parts = cleaned.split(',');

  const imei = parts[1] && /^\d{10,20}$/.test(parts[1]) ? parts[1] : null;
  const type = parts[2] ?? null;

  return { raw, imei, type };
}
