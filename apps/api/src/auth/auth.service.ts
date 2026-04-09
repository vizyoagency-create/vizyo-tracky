import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  fleetId: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      fleetId: user.fleetId,
    };

    const secret = this.config.get('JWT_SECRET', { infer: true });
    const expiresIn = this.config.get('JWT_EXPIRES_IN', {
      infer: true,
    }) as jwt.SignOptions['expiresIn'];

    const accessToken = jwt.sign(payload, secret, { expiresIn });

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        fleetId: user.fleetId,
      },
    };
  }

  verify(token: string): JwtPayload {
    const secret = this.config.get('JWT_SECRET', { infer: true });
    try {
      return jwt.verify(token, secret) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
