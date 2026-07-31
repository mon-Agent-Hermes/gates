// Casse volontaire — validation du critere de fin de l'etape 3 du SETUP.
// Ce module n'est importe nulle part : il n'est jamais execute pendant les probes,
// donc le check `coverage` doit le signaler comme du code mort et virer au rouge.
// A supprimer avec la branche.
export function jamaisAppelee(n: number): number {
  return n * 2
}
