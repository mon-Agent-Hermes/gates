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
  status: "passed" | "failed" | "skipped";
  output: string;
  /** Pourquoi un check est "skipped" : outil absent vs volontairement désactivé. */
  reason?: "tool-missing" | "not-configured";
};

export type GuardrailResult = {
  passed: boolean;
  checks: CheckResult[];
};
