/**
 * fakeAuthUid — identifica auth_uid SINTÉTICOS gerados por import em massa.
 *
 * Esses uids não são identificadores reais do Identity Platform: foram
 * fabricados na hora do import (planilha → banco) para preencher a coluna
 * NOT NULL, e NUNCA vão casar com uma conta no Firebase. Consultar o
 * Identity Platform para eles é uma chamada de rede desperdiçada — sempre
 * volta "conta não existe".
 *
 * Extraído de backfill-worker-names-from-encuadres.ts (era local e não
 * exportado) para reuso em qualquer script que precise separar "uid real,
 * pode ter conta no Firebase" de "uid fabricado no import, nunca terá conta"
 * — ver bulk-archive-stale-workers-2026-01-30.ts.
 */

export const IMPORT_PREFIXES = [
  'anacareimport_',
  'candidatoimport_',
  'pretalnimport_',
  'talentum_',
];

export function isFakeAuthUid(authUid: string | null): boolean {
  if (!authUid) return true;
  return IMPORT_PREFIXES.some((p) => authUid.startsWith(p));
}
