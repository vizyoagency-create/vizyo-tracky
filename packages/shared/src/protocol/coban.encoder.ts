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
