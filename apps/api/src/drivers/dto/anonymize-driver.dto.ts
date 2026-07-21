import { Equals } from 'class-validator';

/** RGPD art. 17 — le client DOIT poser confirm=true (anti-clic accidentel ; l'UI a sa modal). */
export class AnonymizeDriverDto {
  @Equals(true)
  confirm!: boolean;
}
