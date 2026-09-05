import { requiredFleetScope } from '../common/tenant-scope';
import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AiFeatureFlagsDto, AiProviderInfoDto, AiProviderQuarantineDto, AiProviderSettingsDto } from '@vizyo/tracky-shared';
import { AiProviderSettingsService } from '../ai/ai-provider-settings.service';
import { AiFeatureFlagsService } from '../ai/ai-feature-flags.service';
import { AiRouter } from '../ai/ai-router.service';
import { SetAiFeatureFlagBodyDto } from './dto/set-ai-feature-flag.dto';
import { AiUsageService } from './ai-usage.service';
import { SetAiBudgetBodyDto } from './dto/set-ai-budget.dto';
import { SetAiProviderBodyDto } from './dto/set-ai-provider.dto';

/**
 * Palier « Coûts IA » — supervision des dépenses du copilote IA. La CONSULTATION (summary/logs)
 * est ouverte au FLEET_ADMIN, **scopée à sa propre société** (visibilité « qui consomme quoi »).
 * Le BUDGET (plafond global, transverse) reste SUPER_ADMIN uniquement.
 */
@Controller('admin/ai-usage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiUsageController {
  constructor(
    private readonly svc: AiUsageService,
    private readonly aiProvider: AiProviderSettingsService,
    private readonly aiRouter: AiRouter,
    private readonly featureFlags: AiFeatureFlagsService,
  ) {}

  /** GET /api/admin/ai-usage/features — interrupteurs GLOBAUX par fonctionnalité IA (switchboard). */
  @Get('features')
  @Roles(UserRole.SUPER_ADMIN)
  getFeatures(): Promise<AiFeatureFlagsDto> {
    return this.featureFlags.getFlags();
  }

  /** PUT /api/admin/ai-usage/features — coupe/active une fonctionnalité IA POUR TOUT LE MONDE. */
  @Put('features')
  @Roles(UserRole.SUPER_ADMIN)
  setFeature(@Body() dto: SetAiFeatureFlagBodyDto, @Req() req: AuthenticatedRequest): Promise<AiFeatureFlagsDto> {
    return this.featureFlags.setFlag(dto.feature, dto.enabled, req.user.id);
  }

  /** Vue du moteur IA global sélectionné + moteurs disponibles (clé présente) + moteurs à l'écart. */
  private async providerView(): Promise<AiProviderSettingsDto> {
    const setting = await this.aiProvider.view();
    const avail = this.aiRouter.availability();
    // Le libellé est DÉRIVÉ du modèle réellement employé par défaut, jamais écrit en dur : la
    // carte disait « Opus 4.8 » pendant que chaque appel partait sur Sonnet 5 (C3 point 4).
    const providers: AiProviderInfoDto[] = [
      {
        id: 'claude',
        label: `Claude — ${libelleModele(this.aiRouter.modeleParDefaut('claude'))} (défaut)`,
        hint: 'Anthropic · raisonnement agenda & optimisation',
        configured: avail.claude,
      },
      {
        id: 'gpt',
        label: `GPT — ${libelleModele(this.aiRouter.modeleParDefaut('gpt'))} (défaut)`,
        hint: 'OpenAI · analyse de trajets & détection d\'anomalies',
        configured: avail.gpt,
      },
    ];
    // C3 point 1 (2026-09-05) — un moteur mis à l'écart après un refus : l'écran doit le dire,
    // sinon il affiche « Claude » pendant que GPT facture, sans rien qui explique pourquoi.
    const etats = this.aiRouter.etatFournisseurs();
    const quarantines: AiProviderQuarantineDto[] = (['claude', 'gpt'] as const).flatMap((id) => {
      const q = etats[id].quarantaine;
      return q ? [{ provider: id, kind: q.kind, until: q.jusqua }] : [];
    });
    return {
      provider: setting.provider,
      updatedAt: setting.updatedAt,
      providers,
      mixteAvailable: this.aiRouter.mixteAvailable(),
      quarantines,
    };
  }

  /**
   * Périmètre flotte appliqué à la consultation : un FLEET_ADMIN est FORCÉ à sa société
   * (jamais le fleetId du client) ; un SUPER_ADMIN filtre librement (undefined = toutes).
   */
  private scopeFleet(req: AuthenticatedRequest, requested?: string): string | undefined {
    // ⚠️ `?? undefined` etait un FAIL-OPEN : un FLEET_ADMIN sans societe (cas reel apres
    // suppression d'une flotte, `onDelete: SetNull`) obtenait `undefined`, c'est-a-dire
    // TOUTES les flottes — noms des societes, e-mails, couts, et bascule sur le budget
    // plateforme. Le compte le moins legitime avait la vue la plus large.
    return requiredFleetScope(req.user, requested);
  }

  /** GET /api/admin/ai-usage/summary — KPIs + répartitions (action/flotte/utilisateur/jour) + budget. */
  @Get('summary')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  summary(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    // Scope flotte (main : FLEET_ADMIN forcé à sa société) + viewer (owner : masque les owners).
    return this.svc.summary(from, to, this.scopeFleet(req, fleetId), req.user);
  }

  /**
   * GET /api/admin/ai-usage/logs — journal des appels (curseur `before` = ISO ; `after` = borne
   * basse jour ; `failed=1` = échecs seulement).
   */
  @Get('logs')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  logs(
    @Req() req: AuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('after') after?: string,
    @Query('userId') userId?: string,
    @Query('fleetId') fleetId?: string,
    @Query('action') action?: string,
    @Query('failed') failed?: string,
  ) {
    return this.svc.logs({
      limit: limit ? parseInt(limit, 10) : undefined,
      before,
      after,
      userId,
      fleetId: this.scopeFleet(req, fleetId),
      action,
      onlyFailed: failed === '1' || failed === 'true',
    }, req.user);
  }

  /** GET /api/admin/ai-usage/budget — budget mensuel + dépense du mois + statut (global). */
  @Get('budget')
  @Roles(UserRole.SUPER_ADMIN)
  budget(@Req() req: AuthenticatedRequest) {
    // viewer : owner plateforme exclu de la dépense du mois pour un super-admin non-owner.
    return this.svc.getBudget(req.user);
  }

  /** PUT /api/admin/ai-usage/budget — règle le budget mensuel (€) et, s'il est fourni, le taux USD→€. */
  @Put('budget')
  @Roles(UserRole.SUPER_ADMIN)
  setBudget(@Body() dto: SetAiBudgetBodyDto, @Req() req: AuthenticatedRequest) {
    return this.svc.setBudget({ monthlyBudgetEur: dto.monthlyBudgetEur, usdToEurRate: dto.usdToEurRate }, req.user.id, req.user);
  }

  /** GET /api/admin/ai-usage/provider — moteur IA global + disponibilité des moteurs. */
  @Get('provider')
  @Roles(UserRole.SUPER_ADMIN)
  getProvider(): Promise<AiProviderSettingsDto> {
    return this.providerView();
  }

  /** PUT /api/admin/ai-usage/provider — bascule le moteur IA global (Claude ↔ GPT). */
  @Put('provider')
  @Roles(UserRole.SUPER_ADMIN)
  async setProvider(@Body() dto: SetAiProviderBodyDto, @Req() req: AuthenticatedRequest): Promise<AiProviderSettingsDto> {
    await this.aiProvider.set(dto.provider, req.user.id);
    return this.providerView();
  }
}

/**
 * Nom lisible d'un identifiant de modèle : `claude-sonnet-5` → « Sonnet 5 »,
 * `claude-haiku-4-5-20251001` → « Haiku 4.5 », `gpt-4.1-2025-04-14` → « 4.1 »,
 * `gpt-5-mini` → « 5 mini ». Un identifiant d'une autre forme est rendu tel quel : mieux vaut
 * un nom brut qu'un nom inventé.
 */
export function libelleModele(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model);
  if (claude) {
    const famille = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${famille} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  const gpt = /^gpt-([0-9][0-9a-z.]*)(?:-(mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
  if (gpt) return `${gpt[1]}${gpt[2] ? ` ${gpt[2]}` : ''}`;
  return model;
}
