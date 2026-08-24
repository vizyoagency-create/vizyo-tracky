import type { CobanCommand } from './coban.types';
import { formatFrequency } from './coban.utils';

const IMEI_RE = /^\d{15}$/;

export function encodeCommand(imei: string, cmd: CobanCommand): string {
  if (!IMEI_RE.test(imei)) {
    throw new Error(`Invalid IMEI: "${imei}" (must be exactly 15 digits)`);
  }

  const prefix = `**,imei:${imei}`;

  switch (cmd.type) {
    case 'engine_stop':
      return `${prefix},J;`;
    case 'engine_resume':
      return `${prefix},K;`;
    case 'alarm_arm':
      return `${prefix},L;`;
    case 'alarm_disarm':
      return `${prefix},M;`;
    case 'position_single':
      return `${prefix},B;`;
    case 'position_periodic': {
      // TRK-045 — la borne haute RÉELLE est celle du firmware, pas celle d'une journée :
      // `formatFrequency` refuse au-delà de TCP_MAX_FREQUENCY_S (99 s) parce que ce
      // boîtier lit deux chiffres et jette l'unité. On laisse ce garde-fou attraper les
      // valeurs absurdes, et c'est `formatFrequency` qui prononce la vraie limite — son
      // message nomme la cause, celui-ci ne saurait pas le faire.
      if (cmd.frequencySeconds <= 0 || cmd.frequencySeconds > 86400) {
        throw new Error(
          `Invalid frequency: ${cmd.frequencySeconds}s (must be 1-86400)`,
        );
      }
      return `${prefix},C,${formatFrequency(cmd.frequencySeconds)};`;
    }
    case 'position_stop':
      return `${prefix},D;`;
    case 'request_photo':
      return `${prefix},160;`;
    case 'sos_ack':
      return `${prefix},E;`;
    case 'custom':
      return `${prefix},${cmd.raw};`;
  }
}
