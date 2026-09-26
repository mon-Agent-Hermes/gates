Un fichier atteignable UNIQUEMENT par l'alias `@/` déclaré dans `tsconfig.json` —
la convention que `create-next-app` génère par défaut.

Sans résolution des alias, `src/lib/titre.ts` était déclaré injoignable, et le seul
contournement était d'interdire `@/` dans tous les projets : le juge dictait alors
l'écriture du code au lieu de la vérifier (AC-8).
