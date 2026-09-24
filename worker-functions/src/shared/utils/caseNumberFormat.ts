/**
 * Formatação de `case_number` para exibição — spec 027 Fase 6 (T061).
 *
 * `case_number` continua INTEGER no banco (não vira texto — `PatientQueryRepository.ts`
 * faz `::int`, e 11 arquivos têm `ORDER BY case_number`). O prefixo `EN` é só
 * formatação de exibição, decidido pela FAIXA:
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

/**
 * Título de vacante completo: `CASO {formatCaseNumber(caseNumber)}-{vacancyNumber}` —
 * decisão do Gabriel (24/09/2026, D422 — substitui o ponto 6 da D412): a partir de
 * agora o WRITE PATH também usa o número formatado, não só a exibição. `vacancyNumber`
 * é sempre passado cru (sem prefixo — é outro namespace, migration 114); aceita
 * `number | string` porque alguns sítios já têm o valor como string (ex.: vindo de
 * `parseInt` de uma query, ou de `existingVacancy.vacancy_number`).
 *
 * `caseNumber: number | null` de propósito — preserva byte a byte o comportamento
 * dos sítios que hoje interpolam a coluna crua (`number | null` do SELECT) direto no
 * template string: `formatCaseNumber(null)` devolve `null`, e `${null}` dentro de um
 * template literal já virava a string "null" antes desta função existir — nenhum
 * sítio ganha um guard novo aqui (fora de escopo desta task).
 */
export function formatCaseTitle(caseNumber: number | null, vacancyNumber: number | string): string {
  return `CASO ${formatCaseNumber(caseNumber)}-${vacancyNumber}`;
}

/**
 * `formatCaseTitle` sem o `vacancyNumber` — para os 2 sítios que montam/procuram
 * um rótulo "CASO {n}" sem o segundo número:
 *   - `GeminiVacancyParserHelpers.ts`: título inicial do INSERT via parser Gemini,
 *     que ainda não tem `vacancy_number` (gerado só no INSERT real, JobPostingARRepository).
 *   - `ProcessTalentumPrescreening.ts` (`resolveJobPosting`): o searchTerm do ILIKE
 *     não inclui `vacancy_number` de propósito — o `-{m}` do título real varia por
 *     vaga, então o ILIKE bate só no prefixo "CASO {n}" (ou "CASO EN{n}"), como
 *     substring de "CASO EN{n}-{m}, ...".
 * `null` devolve `null` — quem chama decide o fallback (texto livre, `<outro>`).
 */
export function formatCaseNumberTitle(caseNumber: number | null): string | null {
  const formatted = formatCaseNumber(caseNumber);
  return formatted != null ? `CASO ${formatted}` : null;
}
