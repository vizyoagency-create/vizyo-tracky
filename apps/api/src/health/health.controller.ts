import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DemoModeService } from '../demo/demo-mode.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly demoMode: DemoModeService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(@Res({ passthrough: true }) res: Response) {
    const checks = await this.runChecks();
    const allUp = Object.values(checks).every((v) => v === 'connected' || v === 'listening');

    if (!allUp) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: allUp ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '1.3.0',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      services: checks,
      // Environnement de démonstration (2026-09) : le SEUL endroit public où l'écran apprend
      // qu'il parle à la démo — avant toute session, donc dès la page de connexion. Lu par le
      // web au démarrage (DemoModeService côté Angular) pour poser le bandeau.
      demo: this.demoMode.enabled,
    };
  }

  private async runChecks(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};

    // Database
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      results.database = 'connected';
    } catch {
      results.database = 'disconnected';
    }

    return results;
  }
}
