/**
 * Fragmentos SQL únicos do PAGADOR VIGENTE do serviço contratado (spec 087; molde `serviceScheduleSql`).
 *
 * "O serviço tem pagador" = existe vínculo vivo em `contracted_service_contract` cuja vigência contém `asOf`. Esta é a ÚNICA
 * escrita dessa regra em SQL: o leitor da ficha (`payerAtMany`), o portão de recrutamento (`lockRecruitmentContext`), o checklist
 * geral (`MISSING_SQL.COVERAGE`, `PatientCompletenessLoader`) e a lista/Kanban a leem daqui — nenhum reescreve
 * `superseded_at IS NULL AND valid @> …`. Contrato ou Particular (`payerKind = 'PRIVATE'`) contam igual: ambos são vínculo.
 */
import { COUNTRY_TIMEZONE_MAP } from '../locale/CountryTimezone';

/** Vínculo vivo e vigente em `asOfSql` (expressão SQL de data: `$2::date`, `operationDateSql(...)`). Nunca `CURRENT_DATE` (D-43). */
export function linkVigenteSql(linkAlias: string, asOfSql: string): string {
  return `${linkAlias}.superseded_at IS NULL AND ${linkAlias}.valid @> ${asOfSql}`;
}

/** O serviço `pcsAlias` tem vínculo vigente em `asOfSql` ("pagador LINKED" da ficha). */
export function servicePayerLinkedSql(pcsAlias: string, asOfSql: string): string {
  return `EXISTS (SELECT 1 FROM contracted_service_contract csc_pl
        WHERE csc_pl.contracted_service_id = ${pcsAlias}.id AND ${linkVigenteSql('csc_pl', asOfSql)})`;
}

/**
 * Dia de operação do país (data LOCAL), a mesma conta de `operationDateOf` (`COUNTRY_TIMEZONE_MAP`) escrita em SQL para quem
 * não recebe `asOf` por parâmetro (checklist da lista/Kanban). País fora do mapa → `NULL` → sem vínculo vigente (lado seguro,
 * o contrário de cair em UTC por engano).
 */
export function operationDateSql(countryExpr: string): string {
  const arms = Object.entries(COUNTRY_TIMEZONE_MAP)
    .map(([country, tz]) => `WHEN '${country}' THEN '${tz}'`)
    .join(' ');
  return `((NOW() AT TIME ZONE CASE ${countryExpr} ${arms} END)::date)`;
}
