import { Global, Module } from '@nestjs/common';
import { EmailHealthService } from './email-health.service';
import { EmailService } from './email.service';
import { EmailWebhookController } from './email-webhook.controller';
import { GardeFouEnvoisService } from './garde-fou-envois.service';

@Global()
@Module({
  // Webhook Resend (public, protégé par signature Svix) — pas de guard, donc pas
  // besoin d'AuthModule ici (ce qui évite un cycle avec AuthModule↔EmailService).
  controllers: [EmailWebhookController],
  // `EmailHealthService` n'est pas exporté : c'est un cron, personne ne l'appelle.
  // 30/09 — le garde-fou d'envoi (liste blanche, mode recette d'une société) : exporté pour le
  // notifier des réservations publiques (SMS) et la route qui règle le mode recette.
  providers: [EmailService, EmailHealthService, GardeFouEnvoisService],
  exports: [EmailService, GardeFouEnvoisService],
})
export class EmailModule {}
