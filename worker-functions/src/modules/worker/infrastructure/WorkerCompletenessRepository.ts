/**
 * WorkerCompletenessRepository — leitura ÚNICA de "o que falta no cadastro".
 *
 * Por que existe (incidente 08/09/2026): a resposta para "esse cadastro está
 * completo?" estava escrita em SETE lugares — `fn_guard_registered_status`,
 * `fn_worker_missing_fields`, `recalculateStatus`, duas fórmulas distintas de
 * `completeness_score` e, no frontend, `isStep1Complete` + `getStep1Progress`.
 * A cópia do frontend omitia `phone` e `title_certificate`: a prestadora via
 * "cadastro completo" na home e o backend recusava a postulação com "registro
 * incompleto". Medido em produção: 23 pessoas nesse estado exato.
 *
 * A regra vive no banco (`fn_worker_missing_fields`, SSOT declarado desde a
 * migration 209/212). Este módulo a lê e a serve para as rotas do prestador —
 * que a repassam ao frontend em vez de deixá-lo recalcular. Espelha o papel que
 * `PatientCompleteness` já cumpre no domínio de paciente: a MESMA função
 * alimenta o que a tela mostra e o que o portão decide.
 *
 * ⚠️ Ele NÃO é (ainda) o único leitor da função em TypeScript. Há outros dois,
 * no módulo de matching, e um deles usa contrato de tipo DIFERENTE:
 *   - `BlockedApplicationRepository.ts:161` — faz `::text` + `JSON.parse`;
 *   - `blockedAttemptLiveState.ts:122`      — devolve fragmento SQL, não valor.
 * Unificar os três é o item 3 da fila em `estado/postulacao-completude.md`, e
 * NÃO foi feito aqui. Escrever "único" antes de sê-lo seria repetir o defeito
 * que este módulo existe para consertar.
 *
 * NÃO reimplemente a lista aqui. Se um campo entra ou sai do portão, muda a
 * função PL/pgSQL.
 *
 * ── Fase 1 de postulacao-documento-pendente (DD1, 11/09) ──────────────────
 * `readWorkerMissingFields` agora expande `worker_documents` em `doc_*` pelo
 * MESMO ponto único que o 403 do track-channel usa
 * (`documentTokenExpansion.expandDocumentToken`, domínio puro) — o `GET /me`
 * e a resposta do `PUT` (via `readFreshProgress`) deixam de ser o único lugar
 * que devolvia o token cru. A régua do teste de contrato do frontend
 * (`workerProgressValidation.contract.test.ts`) já excluía tokens `doc_*` da
 * checagem de órfão — ela sabia que este dia chegaria.
 */

import { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { expandDocumentToken, type WorkerDocumentRow } from '../domain/documentTokenExpansion';

const TAG = '[WorkerCompletenessRepository]';

/**
 * Lê a linha necessária para expandir `worker_documents` (profissão + as 4
 * URLs de `worker_documents`) para um worker. `null` = worker não encontrado
 * ou absorvido por merge (`merged_into_id`) — mesma semântica que
 * `BlockedApplicationRepository` já usava antes desta extração.
 *
 * Compartilhada entre `readWorkerMissingFields` (abaixo) e
 * `BlockedApplicationRepository.upsert` — ponto único da query, para não
 * duplicar as colunas de F5 em dois lugares (grep de `resume_cv_url`/
 * `criminal_record_url` fora daqui é achado de revisão).
 */
export async function fetchWorkerDocumentRow(
  pool: Pool,
  workerId: string,
): Promise<WorkerDocumentRow | null> {
  const { rows } = await pool.query<WorkerDocumentRow>(
    `SELECT
       w.profession,
       wd.resume_cv_url,
       wd.identity_document_url,
       wd.criminal_record_url,
       wd.at_certificate_url
     FROM workers w
     LEFT JOIN worker_documents wd ON wd.worker_id = w.id
     WHERE w.id = $1
       AND w.merged_into_id IS NULL`,
    [workerId],
  );
  return rows.length === 0 ? null : rows[0];
}

/**
 * Lê os campos que faltam para o worker virar REGISTERED (e, portanto, poder
 * se postular).
 *
 * Retorna `[]` quando o cadastro está completo — o array VAZIO é resposta
 * legítima e significa "nada falta".
 *
 * Retorna `null` quando NÃO foi possível apurar (erro de banco). `null` é
 * "não sei", e é diferente de `[]` ("sei que não falta nada"). Quem consome
 * TEM de tratar `null` como desconhecido e nunca como "está completo" — foi
 * exatamente a confusão entre "ausência de informação" e "informação de
 * ausência" que originou este módulo.
 */
export async function readWorkerMissingFields(
  pool: Pool,
  workerId: string,
): Promise<string[] | null> {
  let missing: string[];
  try {
    const { rows } = await pool.query<{ missing: string[] }>(
      'SELECT fn_worker_missing_fields($1) AS missing',
      [workerId],
    );
    if (rows.length === 0 || rows[0].missing === null) return null;
    missing = rows[0].missing;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    // `reportError`, não `warn`: se a função sumir do banco (migration não
    // aplicada) TODA resposta passa a dizer "não sei" indefinidamente, e com
    // `warn` ninguém é acordado — `severity=ERROR` é o que chega ao Error
    // Reporting. Mesmo modo de falha que o gate reprovou em `readFreshProgress`.
    reportError(e, { source: 'WorkerCompletenessRepository:readWorkerMissingFields' });
    logger.child({ workerId }).warn({ msg: `${TAG} failed to read missing fields` });
    return null;
  }

  if (!missing.includes('worker_documents')) return missing;

  // Expansão em query SEPARADA e NÃO-FATAL: uma falha aqui detalha só QUAL
  // documento falta, e não deve derrubar a completude das outras abas que a
  // primeira query já apurou com sucesso — fallback é o token cru
  // (`worker_documents`), que o frontend já sabe interpretar (F13).
  try {
    const row = await fetchWorkerDocumentRow(pool, workerId);
    return expandDocumentToken(missing, row);
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'WorkerCompletenessRepository:readWorkerMissingFields:expand' });
    logger.child({ workerId }).warn({ msg: `${TAG} failed to expand worker_documents token (non-fatal)` });
    return missing;
  }
}
