import type { CommandStatus, EngineAction } from '@prisma/client';

export interface EngineCommandResponse {
  id: string;
  trackerId: string;
  action: EngineAction;
  status: CommandStatus;
  reason: string | null;
  lastError: string | null;
  requestedBy: string;
  createdAt: Date;
  updatedAt: Date;
}
