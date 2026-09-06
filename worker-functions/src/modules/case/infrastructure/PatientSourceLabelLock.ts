import type { PoolClient } from 'pg';

/**
 * PatientSourceLabelLock — a SERIALIZAÇÃO de toda escrita de rótulos de um mesmo
 * (paciente, campo). É o conserto do defeito 4 do QA-caça, inteiro, num arquivo só.
 *
 * Extraído de `PatientSourceLabelRepository` pelo teto de 400 linhas do `CLAUDE.md`. Mesma
 * consulta, mesmo namespace, mesmo `_xact_` — nada mudou além do endereço.
 */

/**
 * Namespace do lock consultivo. `pg_advisory_xact_lock(int4, int4)` — o primeiro inteiro
 * separa este uso de qualquer outro lock consultivo do sistema; o segundo é o par
 * (paciente, campo). Colisão de hash só causa serialização desnecessária, nunca erro.
 */
const ADVISORY_LOCK_NAMESPACE = 'patient_source_labels';

/**
 * Serializa TODA escrita de rótulos de um mesmo (paciente, campo) — o conserto do defeito 4.
 *
 * O par `DELETE` + `INSERT` não é atômico contra outra transação em READ COMMITTED: o
 * `DELETE` do segundo re-sync não enxerga as linhas que o primeiro acabou de inserir e ainda
 * não commitou, e o `INSERT` bate na PK (`23505`). Medido pelo QA: `sync A: OK` /
 * `sync B: FALHOU 23505`, com listas IDÊNTICAS, enquanto os mesmos dois em SEQUÊNCIA passam.
 *
 * `ON CONFLICT DO NOTHING` não serviria: esconderia a colisão e deixaria o conjunto sendo uma
 * mistura das duas listas. O lock é o que faz a segunda ESPERAR e reescrever o conjunto
 * inteiro — que é a semântica prometida ("o estado reflete a lista atual").
 *
 * `_xact_` é essencial: o lock se solta sozinho no fim da transação, inclusive num rollback.
 * Nada aqui pode ficar segurando lock se o chamador morrer.
 */
export async function lockField(executor: PoolClient, patientId: string, fieldName: string): Promise<void> {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2 || ':' || $3))`,
    [ADVISORY_LOCK_NAMESPACE, patientId, fieldName],
  );
}
