import { Global, Module } from '@nestjs/common';
import { EmailHealthService } from './email-health.service';
import { EmailService } from './email.service';
import { EmailWebhookController } from './email-webhook.controller';

@Global()
@Module({
  // Webhook Resend (public, protégé par signature Svix) — pas de guard, donc pas
  // besoin d'AuthModule ici (ce qui évite un cycle avec AuthModule↔EmailService).
  controllers: [EmailWebhookController],
  // `EmailHealthService` n'est pas exporté : c'est un cron, personne ne l'appelle.
  providers: [EmailService, EmailHealthService],
  exports: [EmailService],
})
export class EmailModule {}
