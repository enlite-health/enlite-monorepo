/**
 * Campos EFETIVOS da vaga (change `vaga-le-do-servico-contratado`, F1).
 *
 * Vaga nascida de um serviço contratado (`contracted_service_id IS NOT NULL`) NÃO é dona do horário: o
 * dono é `patient_contracted_services.schedule`. A cópia em `job_postings.schedule` continua no banco
 * (os escritores seguem copiando até a F7), mas NENHUM leitor a lê: todo leitor obtém o valor por esta
 * peça. O teste `vacancyEffectiveFields.contract.test.ts` reprova o arquivo que ler a coluna crua.
 *
 * Regra do valor efetivo (nunca `COALESCE(serviço, vaga)`):
 *   CASE WHEN jp.contracted_service_id IS NOT NULL THEN <alias_eff>.schedule ELSE jp.schedule END
 * Serviço com horário NULL = "vaga sem horário"; não cai na cópia velha (vazio ambíguo ≠ ausência).
 * Vaga sem serviço lê o próprio `jp.schedule`.
 *
 * Uso: o leitor põe `vacancyEffectiveJoinSql(jp)` no FROM (LEFT JOIN, 1 linha no máximo: join por PK) e
 * `vacancyEffectiveScheduleSql(jp)` (ou `vacancyEffectiveColumnsSql(jp)`, no lugar de `jp.*`) no SELECT.
 * Em query com GROUP BY, agrupar também por `<alias_eff>.id`.
 *
 * ⚠️ RLS: `patient_contracted_services` tem RLS (política `follow_patient`, que depende de `patients`).
 * Sessão que não enxerga o paciente lê o serviço como ausente e o CASE devolve NULL — o mesmo que
 * `p.case_number` faz em `vacancyCaseNumberSql.ts`. O leitor tem de rodar numa sessão com identidade.
 *
 * A F5 acrescentou `providers_needed` e a F6 acrescenta a faixa etária em EFFECTIVE_FIELD_EXPRESSIONS; os leitores
 * que usam `vacancyEffectiveColumnsSql` as recebem sem mudar.
 */

/** Alias padrão do serviço contratado na query do leitor. */
export const VACANCY_EFFECTIVE_SERVICE_ALIAS = 'pcs_eff';

/**
 * TODAS as colunas de `job_postings`, na ordem da tabela. A lista vive AQUI e em nenhum outro lugar:
 * `jp.*`/`SELECT *`/`RETURNING *` são proibidos fora desta peça (contract test). O teste
 * `vacancyEffectiveFields.singleSource` compara esta lista com `information_schema.columns`: coluna nova
 * de migration futura sem entrada aqui reprova o CI em vez de sumir calada das respostas.
 */
export const JOB_POSTING_COLUMNS = [
  'id', 'title', 'description', 'required_languages', 'country', 'is_remote', 'work_schedule', 'status',
  'max_applicants', 'published_at', 'closes_at', 'created_at', 'updated_at', 'case_number', 'priority',
  'is_covered', 'coordinator_name', 'worker_profile_sought', 'schedule_days_hours', 'due_date',
  'search_start_date', 'patient_id', 'weekly_hours', 'providers_needed', 'active_providers',
  'authorized_period', 'marketing_channel', 'assignee', 'daily_obs', 'inferred_zone', 'coordinator_id',
  'assignee_uid', 'deleted_at', 'meet_link_1', 'meet_datetime_1', 'meet_link_2', 'meet_datetime_2',
  'meet_link_3', 'meet_datetime_3', 'talentum_project_id', 'talentum_public_id', 'talentum_whatsapp_url',
  'talentum_slug', 'talentum_published_at', 'talentum_description', 'required_professions', 'required_sex',
  'age_range_min', 'age_range_max', 'required_experience', 'worker_attributes', 'salary_text',
  'payment_day', 'schedule', 'vacancy_number', 'social_short_links', 'enriched_at', 'patient_address_id',
  'service_lat', 'service_lng', 'service_location', 'is_draft', 'timezone', 'is_test',
  'meet_recurring_weekday', 'meet_recurring_time', 'meet_recurring_link', 'contracted_service_id',
  'case_ordinal', 'title_before_en', 'status_before_baja',
] as const;

/** Colunas que a vaga LÊ do serviço: `schedule` (F1) e `providers_needed` (F5); a faixa (F6) entra aqui. */
export const EFFECTIVE_FIELD_EXPRESSIONS: Record<string, (jp: string, eff: string) => string> = {
  schedule: (jp, eff) =>
    `CASE WHEN ${jp}.contracted_service_id IS NOT NULL THEN ${eff}.schedule ELSE ${jp}.schedule END`,
  // `job_postings.providers_needed` é TEXT e `patient_contracted_services.providers_needed` é INT: os dois
  // ramos do CASE precisam do MESMO tipo (Postgres recusa o contrário) e os leitores esperam TEXT
  // (`~ '^[0-9]+$'`, `::INTEGER`). O cast mora AQUI, uma vez; leitor nenhum faz cast próprio.
  providers_needed: (jp, eff) =>
    `CASE WHEN ${jp}.contracted_service_id IS NOT NULL THEN ${eff}.providers_needed::text ELSE ${jp}.providers_needed END`,
};

/** `LEFT JOIN` do serviço contratado da vaga (join por PK: no máximo 1 linha, não multiplica a vaga). */
export function vacancyEffectiveJoinSql(
  jp: string = 'jp',
  eff: string = VACANCY_EFFECTIVE_SERVICE_ALIAS,
): string {
  return `LEFT JOIN patient_contracted_services ${eff} ON ${eff}.id = ${jp}.contracted_service_id`;
}

/** Coluna do serviço para o `GROUP BY` das queries agrupadas (a PK do serviço; o resto é dependente funcional). */
export function vacancyEffectiveGroupBySql(eff: string = VACANCY_EFFECTIVE_SERVICE_ALIAS): string {
  return `${eff}.id`;
}

/** Expressão do horário efetivo (sem alias de saída; o leitor escreve `AS schedule`). */
export function vacancyEffectiveScheduleSql(
  jp: string = 'jp',
  eff: string = VACANCY_EFFECTIVE_SERVICE_ALIAS,
): string {
  return EFFECTIVE_FIELD_EXPRESSIONS.schedule(jp, eff);
}

/** Expressão da quantidade de prestadores efetiva, sempre TEXT (sem alias de saída; o leitor escreve `AS providers_needed`). */
export function vacancyEffectiveProvidersNeededSql(
  jp: string = 'jp',
  eff: string = VACANCY_EFFECTIVE_SERVICE_ALIAS,
): string {
  return EFFECTIVE_FIELD_EXPRESSIONS.providers_needed(jp, eff);
}

/**
 * Lista explícita de colunas no lugar de `jp.*`: cada coluna da vaga, com as migradas trocadas pelo
 * efetivo e o MESMO nome de saída (o consumidor não percebe). Exige o JOIN de `vacancyEffectiveJoinSql`.
 */
export function vacancyEffectiveColumnsSql(
  jp: string = 'jp',
  eff: string = VACANCY_EFFECTIVE_SERVICE_ALIAS,
): string {
  return JOB_POSTING_COLUMNS.map((col) => {
    const expr = EFFECTIVE_FIELD_EXPRESSIONS[col];
    return expr ? `${expr(jp, eff)} AS ${col}` : `${jp}.${col}`;
  }).join(', ');
}

/**
 * Colunas CRUAS (lista explícita no lugar de `SELECT *`/`RETURNING *`), SEM join. Só para código que roda em
 * client de `pool.connect()` cru — sessão sem identidade, onde tocar `patient_contracted_services` estoura
 * `rls_session_without_identity`. O horário que SAI na resposta vem de `vacancyEffectiveScheduleSql`, lido
 * depois na sessão com identidade (`withEffectiveSchedule`); aqui a cópia crua serve só ao que foi gravado/auditado.
 */
export function vacancyRawColumnsSql(): string {
  return JOB_POSTING_COLUMNS.join(', ');
}
