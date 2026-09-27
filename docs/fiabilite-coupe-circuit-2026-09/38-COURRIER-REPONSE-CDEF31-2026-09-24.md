# Courrier de réponse à CDEF31 — incident de la nuit du 23 au 24/09/2026

> Prêt à envoyer. **À : Patricia POUVREAU** · **Cc : Joost HENDRIKS, Tifaine BOULAY**
> Objet suggéré : `RE: Application véhicule inactive — ce qui s'est passé cette nuit`
> Le dernier paragraphe (⚠️) est **optionnel** : à garder si vous voulez couper court à la
> diffusion de la manipulation SMS, à retirer sinon. Voir l'enquête complète dans
> [`37-INCIDENT-CDEF31-…`](./37-INCIDENT-CDEF31-2026-09-24-LE-VEILLEUR-AVEUGLE-PENDANT-QUATRE-DEPLOIEMENTS.md).

---

Madame POUVREAU,

Merci pour votre message, et surtout pour sa précision : les horaires que vous donnez nous ont permis
de retrouver la nuit minute par minute. **Vous avez raison, et le problème vient de chez nous.**

**Ce que nous avons vérifié.** Nous avons repris l'intégralité des journaux de la nuit. Vos
manipulations y sont, exactement là où vous les situez : vers 1h51, puis de nouveau entre 2h46 et
2h58. Vous avez bien passé une vingtaine de minutes à essayer de rallumer un véhicule.

**Ce qui s'est réellement passé.** Le service n'est pas tombé, et vos ordres sont tous partis et ont
tous été exécutés par les boîtiers. Mais **l'écran vous montrait un état faux** : le bouton ne
reflétait plus la situation réelle des véhicules. Concrètement, il pouvait afficher « Rallumer » sur
un véhicule déjà rallumé, et surtout ne pas proposer le rallumage sur le véhicule qui en avait
besoin. Vous cliquiez juste ; c'est l'application qui ne suivait plus.

Deux éléments ont provoqué cela, et les deux sont de notre responsabilité :

1. **Une mise à jour de nos serveurs était en cours cette nuit-là**, entre 0h56 et 1h40. Chaque mise
   à jour coupe brièvement la liaison temps réel entre l'application et nos serveurs — c'est cette
   liaison qui tient l'état des boutons à jour. Vous avez d'ailleurs dû vous reconnecter cinq fois
   en dix minutes : c'était cela.
2. **Le compte de veille de nuit est le plus exposé à ce défaut.** Pour des raisons de
   cloisonnement, il ne reçoit pas l'historique détaillé des commandes ; il dépend donc entièrement
   de cette liaison temps réel. Quand elle se coupe, il est le seul à ne pas pouvoir se rattraper
   tout seul.

Nous ne referons plus de mise à jour sur cette plage horaire tant que les véhicules sont sous
coupure programmée. Les correctifs applicatifs sont engagés cette semaine : l'application
resynchronisera l'état réel des véhicules à chaque reconnexion, et le bouton affichera clairement
l'état du véhicule au lieu d'une simple bascule.

**Un numéro pour la nuit, dès maintenant.** Vous avez raison, il n'existait pas de contact en dehors
des horaires de bureau. C'est corrigé :

> **📱 WhatsApp — 06 56 69 16 15**
> Pour toute urgence véhicule, 24 h/24. Un message suffit : plaque + ce que vous constatez.

**Une procédure de secours écrite.** Nous vous transmettons dans les prochains jours un document
court décrivant la marche à suivre quand l'application ne répond pas ou affiche un état douteux —
y compris la procédure de déverrouillage de secours, encadrée et traçable. L'objectif est que
personne n'ait plus à chercher sur internet à 3 h du matin.

Nous sommes sincèrement désolés de la nuit que cela vous a fait passer. Votre signalement a mis en
évidence un défaut réel que nos contrôles automatiques n'avaient pas vu — il nous est utile.

Bien cordialement,

**Youness HADDOU**
Vizyo Agency — Tracky

---

⚠️ *Un point à part, et important.* Nous vous remercions de **ne pas rediffuser par courriel la
commande SMS de déverrouillage** ni l'emplacement de la carte SIM dans le boîtier. Cette manipulation
contourne l'application : elle ne laisse aucune trace, ne vérifie aucun droit, et fonctionne pour
quiconque en a connaissance. Nous intervenons cette semaine sur le paramétrage des boîtiers pour
neutraliser cet accès. La procédure de secours mentionnée plus haut la remplacera par un moyen sûr.
