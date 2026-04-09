import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, JwtPayload } from '../auth.service';

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = header.slice(7);
    req.user = this.auth.verify(token);
    return true;
  }
}
