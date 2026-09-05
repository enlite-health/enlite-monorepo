import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { tetoDoCampo, PatientSourceLabelCeilingError } from './PatientSourceLabelCeiling';
import { classify, firstFreeOrdinal } from './PatientSourceLabelClassifier';
import { lockField } from './PatientSourceLabelLock';
import { recordRejectionsDurably, warnIfAnythingWasRefused } from './PatientSourceLabelRejectionRecorder';
import type {
  PatientSourceLabelRejection,
  PatientSourceLabelRejectionRow,
  PatientSourceLabelRow,
  PatientSourceLabelWriteInput,
  PatientSourceLabelWriteResult,
} from './PatientSourceLabelRead';

// ── A porta pública do rótulo cru ─────────────────────────────────────────────
// Teto, contrato de leitura e classificação puro moram em arquivos próprios desde a quebra
// pelo teto de 400 linhas do `CLAUDE.md`. Este arquivo segue sendo o endereço de todos eles:
// nenhum chamador (barril, script ou suíte) precisou trocar de import.
export {
  PATIENT_SOURCE_LABEL_CEILING,
  PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO,
  tetoDoCampo,
  PatientSourceLabelCeilingError,
} from './PatientSourceLabelCeiling';
export { sourceLabelsRead, sourceLabelsUnreadable } from './PatientSourceLabelRead';
export type {
  PatientSourceLabelRejectionReason,
  PatientSourceLabelRejection,
  PatientSourceLabelsRead,
  PatientSourceLabelWriteInput,
  PatientSourceLabelWriteOutcome,
  PatientSourceLabelWriteResult,
  PatientSourceLabelRow,
  PatientSourceLabelRejectionRow,
} from './PatientSourceLabelRead';
export { classify } from './PatientSourceLabelClassifier';

/**
 * PatientSourceLabelRepository — o RÓTULO CRU da origem, ao lado do derivado.
 *
 * Task 2.2 da change `campos-admissao`. Tabelas: migration 304.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────
 * O mapper colapsa DE PROPÓSITO as opções do ClickUp em enums nossos (F32:
 * `AT para Pacientes con TEA` e `Cuidado Integral de Pacientes con TEA` viram o MESMO
 * `ASD`, e o nível de serviço SOME). A Fase 1 fez o fallback GRITAR quando o rótulo é
 * desconhecido — mas gritar sem guardar o cru só troca perda silenciosa por perda
 * barulhenta (D-A.2). Aqui o rótulo LITERAL fica guardado, sempre, inclusive — e
 * principalmente — quando o derivado sai nulo: é isso que torna um rename na origem
 * REVERSÍVEL, porque o dado continua lá para ser remapeado depois.
 *
 * ── O TETO É DO BANCO; ISTO É A CAMADA QUE NÃO DEIXA ELE ESTOURAR EM SILÊNCIO ─
 * `patient_source_labels` só tem três posições por (paciente, campo) — PK + CHECK, sem
 * caminho para uma quarta linha (migration 304). Esta classe NÃO é o teto: ela é quem
 * GRITA E TRUNCA COM REGISTRO em vez de deixar o INSERT explodir ou de descartar calado
 * (Risks do `design.md`). Se esta classe sumisse, o banco continuaria recusando o 4º.
 *
 * ── ONDE CADA METADE DA RECUSA MORA (spec × C1 do `lex`) ─────────────────────
 * A spec exige que a recusa identifique o paciente e o valor recusado. A C1 do parecer
 * PROÍBE identificador de paciente e valor clínico em linha de log — o destino do
 * `console.warn` é o bucket `_Default` global, sem restrição de acesso, e o uuid/rótulo é
 * o valor clínico em forma decodificável por quem tem o token.
 *   → o REGISTRO durável vai para `patient_source_label_rejections`, dentro do banco;
 *   → a linha de LOG leva nome do campo + CONTAGEM, que é exatamente o que a C1 permite
 *     ("o campo X descartou N valores nesta rodada") e o que o operador precisa.
 *
 * ══ OS QUATRO DEFEITOS DO QA-CAÇA DA 2.2 QUE ESTE ARQUIVO FECHA ══════════════
 *
 * DEFEITO 2 — lista vazia APAGAVA o cru. `replaceForField({labels: []})` e `{labels: null}`
 *   deletavam os 3 rótulos gravados, sem registro, sem aviso, devolvendo sucesso. E `[]` é
 *   EXATAMENTE o que `ClickUpFieldResolver.resolveLabels` devolve quando NÃO CONSEGUE LER o
 *   campo (`if (!map) { warn; return []; }`) — a mesma forma para "ninguém preencheu" e para
 *   "o campo sumiu". É o `null` sobrecarregado da D167/F41 renascido dentro da tabela criada
 *   para sobreviver a ele: o rename é o evento que ESVAZIAVA a tabela da reversibilidade.
 *   ⇒ Conserto: a entrada deixa de ser uma lista e passa a ser uma LEITURA declarada
 *   (`PatientSourceLabelsRead`). O chamador tem de dizer, no tipo, se conseguiu ler. Não é
 *   `COALESCE` (a D-E o proíbe, e com razão: congelado *parece* dado) — vazio LEGÍTIMO
 *   continua apagando, que é o comportamento certo; só "não consegui ler" não escreve nada.
 *
 * DEFEITO 3 — o registro durável SUMIA no rollback do chamador. As recusas eram gravadas com
 *   o client do chamador; `PatientService.runUpsertTransaction` faz `ROLLBACK` em qualquer
 *   erro do upsert, e levava junto a única metade da recusa que identifica paciente e valor.
 *   Sobrava o `console.warn` com contagem — o alarme sem endereço.
 *   ⇒ Conserto: a recusa é gravada FORA da transação do chamador, numa conexão própria do
 *   pool, com transação própria. Rollback do chamador não a alcança.
 *
 * DEFEITO 4 — dois re-syncs CONCORRENTES do mesmo (paciente, campo) colidiam em
 *   `23505 patient_source_labels_pkey`: em READ COMMITTED o `DELETE` do segundo não enxerga
 *   as linhas que o primeiro acabou de inserir, e o `INSERT` bate na PK. Como o chamador tem
 *   tudo numa transação só, o upsert INTEIRO do paciente era perdido — identidade, clínico,
 *   endereços — e o webhook respondia `200 success:true`.
 *   ⇒ Conserto: lock consultivo por (paciente, campo), na transação, antes do DELETE. A
 *   idempotência prometida no docstring passa a valer também para a concorrência, não só
 *   para o tempo.
 *
 * DEFEITO 8 — cada re-sync acima do teto acrescentava OUTRA linha de recusa idêntica (com o
 *   rótulo clínico cru e o `patient_id`) e OUTRO `console.warn`: dado clínico crescendo sem
 *   regra e alarme afogado em ruído (critério 9.4 desta change).
 *   ⇒ Conserto: a recusa é ÚNICA por (paciente, campo, rótulo, motivo) — índice único no
 *   banco + `ON CONFLICT DO UPDATE` que incrementa `occurrences` e move `rejected_at`. O
 *   aviso sai só quando a recusa é NOVA; repetição não some (o contador cresce), ela só
 *   deixa de gritar a mesma coisa toda rodada.
 */

export class PatientSourceLabelRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Substitui o conjunto de rótulos crus de UM campo para UM paciente.
   *
   * É o caminho do sync: a origem manda a lista inteira do campo a cada tarefa, então o
   * estado persistido tem de refletir a lista atual — não acumular. O que passar do teto é
   * TRUNCADO com registro, nunca descartado em silêncio.
   *
   * Idempotente: rodar duas vezes com a mesma lista deixa exatamente as mesmas linhas —
   * inclusive quando as duas rodam AO MESMO TEMPO (defeito 4: o lock consultivo abaixo).
   *
   * NÃO APAGA quando a origem não pôde ser lida (defeito 2): `read.readable === false`
   * devolve `outcome: 'skipped-unreadable'` sem tocar em nada.
   */
  async replaceForField(
    input: PatientSourceLabelWriteInput,
    client?: PoolClient,
  ): Promise<PatientSourceLabelWriteResult> {
    const source = input.source ?? 'clickup';

    if (!input.read.readable) {
      // O conserto do defeito 2, e ele é uma NÃO-AÇÃO: sem DELETE, sem INSERT. "Não consegui
      // ler" nunca pode virar "está vazio" — é a tabela da reversibilidade que estava sendo
      // esvaziada justamente pelo evento (rename na origem) que ela existe para sobreviver.
      // C1: nome do campo + motivo estrutural. Nenhum valor, nenhum paciente.
      console.warn('[PatientSourceLabelRepository] origem ILEGÍVEL — nada gravado e nada apagado (D167/F41):', {
        field:  input.fieldName,
        reason: input.read.reason,
      });
      return {
        fieldName: input.fieldName, outcome: 'skipped-unreadable',
        received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0,
        rejectionsDurable: 'not-applicable',
      };
    }

    const plan = classify(input.read.labels, input.fieldName);

    await this.inTransaction(client, async (executor) => {
      await lockField(executor, input.patientId, input.fieldName);

      await executor.query(
        `DELETE FROM patient_source_labels WHERE patient_id = $1 AND field_name = $2`,
        [input.patientId, input.fieldName],
      );

      for (let i = 0; i < plan.accepted.length; i++) {
        await executor.query(
          `INSERT INTO patient_source_labels
             (patient_id, field_name, ordinal, raw_label, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [input.patientId, input.fieldName, i + 1, plan.accepted[i], source],
        );
      }
    });

    const registro = await recordRejectionsDurably(
      this.pool, input.patientId, input.fieldName, plan.rejected, plan.received, source, client,
    );
    warnIfAnythingWasRefused(input.fieldName, plan, registro);
    return {
      fieldName: input.fieldName, outcome: 'written', ...plan,
      newlyRejected: registro.newlyRejected, rejectionsDurable: registro.durability,
    };
  }

  /**
   * Acrescenta UM rótulo cru ao que já existe — o caminho "uma quarta classificação chega
   * para o mesmo paciente" da spec.
   *
   * Recusa com `PatientSourceLabelCeilingError` quando o teto já está cheio, REGISTRA a
   * recusa no banco — FORA da transação do chamador, para que o `ROLLBACK` dele não leve o
   * registro junto (defeito 3) — e deixa os anteriores intactos. Duplicata exata é no-op
   * registrado.
   *
   * O teto é conferido aqui E no banco: a conferência daqui existe para produzir a recusa
   * legível e o registro; o banco é quem torna a quarta linha IMPOSSÍVEL, inclusive para
   * quem não passe por esta classe.
   */
  async appendForField(
    input: { patientId: string; fieldName: string; label: unknown; source?: string },
    client?: PoolClient,
  ): Promise<PatientSourceLabelWriteResult> {
    const source = input.source ?? 'clickup';
    const plan = classify([input.label], input.fieldName);

    type Decisao = {
      estourouOTeto: boolean;
      stored: number;
      accepted: string[];
      rejected: PatientSourceLabelRejection[];
      received: number;
      empty: number;
    };

    // Ler-e-decidir-e-inserir dentro da MESMA transação, sob o mesmo lock do caminho de
    // substituição: sem isso, dois appends simultâneos leem "2 gravados" e inserem o 3º e o
    // 4º — ou colidem na PK. Mesma raiz do defeito 4.
    const decisao = await this.inTransaction(client, async (executor): Promise<Decisao> => {
      await lockField(executor, input.patientId, input.fieldName);

      if (plan.accepted.length === 0) {
        // Vazio ou inválido: `classify` já decidiu, e a recusa (se houver) é registrada fora.
        return { estourouOTeto: false, stored: 0, accepted: [], rejected: plan.rejected, received: plan.received, empty: plan.empty };
      }

      const existing = await executor.query<{ ordinal: number; raw_label: string }>(
        `SELECT ordinal, raw_label FROM patient_source_labels
          WHERE patient_id = $1 AND field_name = $2 ORDER BY ordinal`,
        [input.patientId, input.fieldName],
      );
      const stored = existing.rows.map(r => r.raw_label);
      const label = plan.accepted[0];

      if (stored.includes(label)) {
        return { estourouOTeto: false, stored: stored.length, accepted: [], received: 1, empty: 0,
                 rejected: [{ rawLabel: label, reason: 'duplicate' }] };
      }

      const tetoAqui = tetoDoCampo(input.fieldName);
      if (tetoAqui !== null && stored.length >= tetoAqui) {
        return { estourouOTeto: true, stored: stored.length, accepted: [], received: 1, empty: 0,
                 rejected: [{ rawLabel: label, reason: 'ceiling' }] };
      }

      const proximo = firstFreeOrdinal(existing.rows.map(r => r.ordinal), input.fieldName);
      await executor.query(
        `INSERT INTO patient_source_labels
           (patient_id, field_name, ordinal, raw_label, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [input.patientId, input.fieldName, proximo, label, source],
      );
      return { estourouOTeto: false, stored: stored.length, accepted: [label], rejected: [], received: 1, empty: 0 };
    });

    // FORA da transação do chamador — é o ponto inteiro do conserto do defeito 3. Se isto
    // rodasse antes do `throw` mas DENTRO da transação dele, o `ROLLBACK` de
    // `PatientService.runUpsertTransaction` apagaria a única metade da recusa que diz QUAL
    // paciente e QUAL valor.
    const registro = await recordRejectionsDurably(
      this.pool, input.patientId, input.fieldName, decisao.rejected, decisao.received, source, client,
    );
    warnIfAnythingWasRefused(
      input.fieldName,
      { received: decisao.received, empty: decisao.empty, accepted: decisao.accepted, rejected: decisao.rejected },
      registro,
    );

    if (decisao.estourouOTeto) {
      throw new PatientSourceLabelCeilingError(input.fieldName, decisao.stored, tetoDoCampo(input.fieldName) ?? -1);
    }

    return {
      fieldName: input.fieldName,
      outcome: 'written',
      received: decisao.received,
      empty: decisao.empty,
      accepted: decisao.accepted,
      rejected: decisao.rejected,
      newlyRejected: registro.newlyRejected,
      rejectionsDurable: registro.durability,
    };
  }

  /**
   * Suprime TODO rótulo cru e TODA linha de recusa de um paciente. É o cumprimento real da
   * **C-B do parecer do `lex` (24/08)** — e ele existe porque a alternativa não funcionava.
   *
   * ── O que a migration 304 afirmava, e por que era falso ──────────────────────
   * As duas tabelas têm `patient_id ... REFERENCES patients(id) ON DELETE CASCADE`, e o
   * comentário da migration apresentava esse CASCADE como o cumprimento dos arts. 4º inc. 5 e
   * 16 da Ley 25.326. **O CASCADE nunca dispara.** Medido: `grep -rn "DELETE FROM patients"`
   * no código de aplicação = ZERO; o único caminho de exclusão é
   * `UPDATE patients SET deleted_at = NOW()` (`ClickUpPatientWebhookController`, evento
   * `taskDeleted`). E isso não é uma lacuna a ser fechada com um `DELETE` — é **requisito de
   * produto**: a ata `2026-07-22a#REQ-04` registra *"ID único de paciente e nunca apagar
   * cadastro (soft delete), para preservar rastreabilidade de quem retorna"*.
   *
   * ⇒ O paciente PERMANECE, por decisão. O que não pode permanecer é o dado clínico literal
   * pendurado nele depois que a origem o removeu. Por isso a supressão é explícita, aqui, em
   * vez de implícita numa FK que nunca é exercida.
   *
   * ── Por que apaga de verdade em vez de marcar ────────────────────────────────
   * Estas tabelas não têm `deleted_at`, e não devem ter: a finalidade delas é reversibilidade
   * de rótulo da ORIGEM (art. 4º inc. 1 — pertinente à finalidade). Quando a origem some, a
   * finalidade some junto, e o art. 4º inc. 7 manda destruir *"cuando hayan dejado de ser
   * necesarios o pertinentes a los fines para los cuales hubiesen sido recolectados"*. Marcar
   * como apagado guardaria o dado sensível sem finalidade — o oposto do dever.
   *
   * ⚠️ O `patients.clinical_specialty` (o DERIVADO) NÃO é tocado aqui, de propósito: ele é
   * anterior a esta change, é categoria de uma lista fechada de 9, e mexer nele seria mudar o
   * comportamento do soft delete para além do que esta fase introduziu.
   *
   * Devolve o que apagou, em CONTAGEM — nunca rótulo (C1).
   */
  async purgeForPatient(patientId: string, client?: PoolClient): Promise<{ labels: number; rejections: number }> {
    const exec = client ?? this.pool;
    const r1 = await exec.query('DELETE FROM patient_source_labels WHERE patient_id = $1', [patientId]);
    const r2 = await exec.query('DELETE FROM patient_source_label_rejections WHERE patient_id = $1', [patientId]);
    const apagados = { labels: r1.rowCount ?? 0, rejections: r2.rowCount ?? 0 };
    // C1: contagem e id de paciente (que já é a chave do evento de supressão), nunca rótulo.
    console.info('[PatientSourceLabelRepository] rótulos crus suprimidos com o paciente (C-B/lex):', {
      patientId, ...apagados,
    });
    return apagados;
  }

  async findByPatientId(patientId: string, fieldName?: string): Promise<PatientSourceLabelRow[]> {
    const result = await this.pool.query<PatientSourceLabelRow>(
      `SELECT patient_id AS "patientId", field_name AS "fieldName",
              ordinal, raw_label AS "rawLabel", source
         FROM patient_source_labels
        WHERE patient_id = $1
          AND ($2::text IS NULL OR field_name = $2)
        ORDER BY field_name, ordinal`,
      [patientId, fieldName ?? null],
    );
    return result.rows;
  }

  async listRejections(patientId: string, fieldName?: string): Promise<PatientSourceLabelRejectionRow[]> {
    const result = await this.pool.query<PatientSourceLabelRejectionRow>(
      `SELECT patient_id AS "patientId", field_name AS "fieldName",
              raw_label AS "rawLabel", reason, ceiling, received, occurrences,
              first_rejected_at AS "firstRejectedAt",
              rejected_at AS "rejectedAt",
              last_warned_at AS "lastWarnedAt"
         FROM patient_source_label_rejections
        WHERE patient_id = $1
          AND ($2::text IS NULL OR field_name = $2)
        ORDER BY rejected_at DESC`,
      [patientId, fieldName ?? null],
    );
    return result.rows;
  }

  /**
   * Roda `fn` numa transação. Com `client`, é a transação DO CHAMADOR (entrar em outra aqui
   * quebraria o rollback dele); sem `client`, abre uma própria. Em qualquer caso existe UMA
   * transação — é o que dá sentido ao `pg_advisory_xact_lock`, que se solta no fim dela.
   */
  private async inTransaction<T>(
    client: PoolClient | undefined,
    fn: (executor: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return fn(client);

    const own = await this.pool.connect();
    try {
      await own.query('BEGIN');
      const out = await fn(own);
      await own.query('COMMIT');
      return out;
    } catch (err) {
      await own.query('ROLLBACK').catch(() => { /* a conexão já pode ter morrido */ });
      throw err;
    } finally {
      own.release();
    }
  }
}
