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
 * função PL/pgSQL — e o teste de contrato do frontend acusa quem não seguiu.
 */

import { Pool } from 'pg';
import { logger } from '@shared/logging';

const TAG = '[WorkerCompletenessRepository]';

/**
 * Tokens que a função pode devolver, para o contrato ficar explícito no TS.
 * É documentação do contrato — a VERDADE é a função no banco, não esta lista.
 * Um token novo no banco que não esteja aqui continua trafegando (o tipo é
 * `string`), e o teste de contrato do frontend é quem reprova a divergência.
 */
export const WORKER_MISSING_FIELD_TOKENS = [
  'first_name',
  'last_name',
  'sex',
  'gender',
  'birth_date',
  'document_number',
  'languages',
  'phone',
  'profession',
  'knowledge_level',
  'title_certificate',
  'years_experience',
  'experience_types',
  'preferred_types',
  'preferred_age_range',
  'worker_service_areas',
  'worker_availability',
  'worker_documents',
  'worker_not_found',
] as const;

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
  try {
    const { rows } = await pool.query<{ missing: string[] }>(
      'SELECT fn_worker_missing_fields($1) AS missing',
      [workerId],
    );
    if (rows.length === 0 || rows[0].missing === null) return null;
    return rows[0].missing;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.child({ workerId }).warn({
      msg: `${TAG} failed to read missing fields`,
      error: e.message,
    });
    return null;
  }
}
