/**
 * Formatação de `case_number` para exibição — spec 027 Fase 6 (T061), espelho de
 * `worker-functions/src/shared/utils/caseNumberFormat.ts`.
 *
 * `case_number` continua INTEGER no banco — o prefixo `EN` é só formatação de
 * exibição, decidido pela FAIXA:
 *   - legado do ClickUp: **1..828**, congelado em 23/09/2026 (não numera mais) → sem prefixo.
 *   - sequence nativa (migration 459): começa em **1000** → prefixo `EN`.
 * Não há sobreposição entre as duas faixas, então o corte em 1000 é seguro.
 *
 * `null` não tem regra própria aqui — quem chama decide o fallback (ex.: na
 * exibição de vaga, cair para o `vacancy_number` global). Use `formatCaseLabel`
 * quando esse fallback for exatamente esse.
 */
export function formatCaseNumber(caseNumber: number | null): string | null {
  if (caseNumber == null) return null;
  return caseNumber >= 1000 ? `EN${caseNumber}` : `${caseNumber}`;
}

/**
 * `formatCaseNumber` com o fallback padrão de exibição de vaga: `case_number`
 * ausente cai para o `vacancy_number` global (sem prefixo — é outro namespace,
 * migration 114). Sem os dois, devolve `null` — quem chama decide o traço/rótulo.
 */
export function formatCaseLabel(caseNumber: number | null, vacancyNumberFallback: number | null): string | null {
  const formatted = formatCaseNumber(caseNumber);
  if (formatted != null) return formatted;
  if (vacancyNumberFallback != null) return `${vacancyNumberFallback}`;
  return null;
}

/**
 * Formata a posição ordinal de uma vaga dentro do caso (`job_postings.case_ordinal`,
 * migration 460) — `#NN`, zero-padded em 2 dígitos. `null` passa direto (vaga sem
 * `patient_id`, ou dado ainda não calculado).
 */
export function formatCaseOrdinal(ordinal: number | null): string | null {
  if (ordinal == null) return null;
  return `#${String(ordinal).padStart(2, '0')}`;
}
