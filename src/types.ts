/**
 * Types partagés des garde-fous.
 *
 * `CheckResult` vivait dans `sandbox.ts`, mais `page-check.ts` l'importait en
 * retour — un cycle sandbox ↔ page-check. On l'isole ici pour que la dépendance
 * redevienne à sens unique : sandbox → page-check → types.
 */

export type FileSpec = { path: string; content: string };

export type CheckResult = {
  name: string;
  /**
   * `warn` = SIGNALÉ : le check a trouvé quelque chose, mais ne bloque pas. Il ne change
   * ni `ok` ni le code de sortie. C'est l'état des contrôles en observation (un contrôle
   * neuf signale d'abord, et ne bloque qu'après plusieurs projets sans faux positif) et de
   * ce qui n'est pas objectif — un score de performance, un avertissement de linter.
   */
  status: "passed" | "failed" | "skipped" | "warn";
  output: string;
  /** Pourquoi un check est "skipped" : outil absent vs volontairement désactivé. */
  reason?: "tool-missing" | "not-configured";
};

export type GuardrailResult = {
  passed: boolean;
  checks: CheckResult[];
};
