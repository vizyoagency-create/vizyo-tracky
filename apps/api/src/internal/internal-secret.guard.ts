import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.validation';

@Injectable()
export class InternalSecretGuard implements CanActivate {
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('INTERNAL_API_SECRET', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-internal-secret'];
    if (header !== this.secret) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    return true;
  }
}
