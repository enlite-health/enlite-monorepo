/**
 * src/shared/audit/contactAccessLog.ts
 *
 * C6 — trilha AGREGADA de acesso a contato de prestador. Uma linha por REQUEST
 * em que contato de fato atravessou a fronteira, não uma por prestador.
 *
 * ⚠️ LEIA ANTES DE MEXER — cada ausência aqui é condição, não esquecimento:
 *  - **sem telefone e sem nome.** A trilha guarda o VÍNCULO (operador↔prestador),
 *    nunca o dado. Guardar o dado faria dela uma segunda cópia daquilo que ela
 *    existe para vigiar.
 *  - **sem path cru.** Só a célula. O path leva id de vaga e, cruzado com o log
 *    de request do Cloud Run, reconstrói mais do que a linha deveria dizer — a
 *    mesma razão da M1-5, que proíbe `traceId` no `staff_access`.
 *  - **request que redigiu tudo NÃO vira linha.** Nada foi revelado. Registrar
 *    "tentou ver" transforma trilha de acesso em trilha de comportamento — outro
 *    tratamento, outra base legal, e a política de finalidade (M1-2) proíbe
 *    expressamente uso disciplinar.
 *
 * Fail-safe como a irmã (`resourceAccessLog`): a gravação sai depois da resposta
 * e qualquer erro vira log, nunca 500. Auditoria não derruba atendimento.
 */

import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withSystemDbContext } from '@shared/database/requestDbSession';

const SYSTEM_LABEL = 'job:contact-access-log';

export interface ContactAccessEntry {
  tenantId: string;
  operatorUid: string;
  /** A célula que autorizou. Nunca o path. */
  cell: string;
  /** Prestadores cujo contato SAIU. Vazio = nada a registrar. */
  workerIds: string[];
  country?: string | null;
}

/**
 * Grava a linha agregada. Deduplica os ids — a mesma pessoa pode aparecer em
 * dois cards da mesma tela, e `n` tem de contar PESSOAS, não linhas de tela.
 */
export async function recordContactAccess(entry: ContactAccessEntry): Promise<void> {
  const unicos = [...new Set(entry.workerIds.filter(Boolean))];
  // Nada saiu → nada a afirmar. O CHECK da 284 recusaria de qualquer forma; sair
  // aqui evita a ida ao banco e deixa a razão escrita.
  if (unicos.length === 0) return;

  const pool = DatabaseConnection.getInstance().getPool();
  await pool.query(
    `INSERT INTO iam.contact_access_log
       (tenant_id, operator_uid, cell, worker_ids, n, country)
     VALUES ($1, $2, $3, $4::uuid[], $5, $6)`,
    [entry.tenantId, entry.operatorUid, entry.cell, unicos, unicos.length, entry.country ?? null],
  );
}

/**
 * Dispara a gravação sem bloquear a resposta e sem poder derrubá-la.
 *
 * ⚠️ Devolve `void` de propósito: quem chama NÃO deve `await`. Se a trilha
 * entrasse no caminho da resposta, um KMS lento ou um banco ocupado viraria
 * latência na tela do recrutador — e a primeira reação a isso seria desligar a
 * trilha.
 */
export function emitContactAccess(entry: ContactAccessEntry): void {
  void withSystemDbContext(SYSTEM_LABEL, () => recordContactAccess(entry)).catch((err) => {
    logger.warn(
      {
        err,
        operatorUid: entry.operatorUid,
        cell: entry.cell,
        n: entry.workerIds.length,
        // ⚠️ os IDS NÃO vão para o log de erro: o log de erro carrega o uid do
        // operador, e somar os ids publicaria no Cloud Logging exatamente o
        // vínculo que a tabela existe para guardar sob acesso restrito (lex C2).
      },
      '[abac] falha ao gravar trilha de contato',
    );
  });
}
