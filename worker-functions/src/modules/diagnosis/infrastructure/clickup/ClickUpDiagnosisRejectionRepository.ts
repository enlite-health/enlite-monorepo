/**
 * ClickUpDiagnosisRejectionRepository — registra rótulo de "Tipo de Patología" SEM
 * mapeamento (spec 016 F4, D260: "o que não mapear fica em LISTA, nunca inventado").
 *
 * Reusa `patient_source_label_rejections` (migration 304) — a mesma tabela que já serve de
 * registro durável para rótulo cru recusado por outro campo (ceiling/blank/duplicate),
 * ampliada na migration 326 com `reason='unmapped'` e na 329 com `reason='unreadable'`. Não
 * cria uma segunda tabela para o mesmo conceito ("a origem mandou e não bateu em nada
 * conhecido").
 *
 * DOIS motivos, porque são dois fatos diferentes e a operação age diferente em cada um:
 *   `unmapped`   — HÁ rótulo, legível, e ele não tem linha em `clickup_diagnosis_labels`.
 *                  Conserto: cadastrar o mapeamento. O rótulo É gravado, é o dado acionável.
 *   `unreadable` — NÃO HÁ rótulo: o catálogo do ClickUp não traduz mais o valor que a origem
 *                  mandou. Conserto: arrumar a OPÇÃO no ClickUp. Nada do valor é gravado (o
 *                  orderindex é dado clínico codificado) — ver `recordUnreadable`.
 *
 * ⚠️ Escopo DELIBERADAMENTE menor que `PatientSourceLabelRepository`: sem lock consultivo, sem
 * conexão própria fora da transação do chamador, sem janela de silêncio para o alarme. O
 * volume aqui é o de um ÚNICO campo (`Tipo de Patología`, seleção única) sincronizado por
 * webhook — não a leva de 8 campos de catálogo por paciente que motivou aquela robustez. Uma
 * concorrência rara duplicando `occurrences` não perde o registro (o índice único ainda
 * garante uma linha por rótulo, só a contagem de re-tentativas simultâneas pode ficar
 * imprecisa) — trade-off aceitável e citado aqui para quem for medir depois.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

const DIAGNOSIS_FIELD_NAME = 'Tipo de Patología';

export interface ClickUpDiagnosisRejectionPort {
  recordUnmapped(patientId: string, rawLabel: string): Promise<void>;
  /**
   * A recusa SEM valor: a origem mandou algo e o catálogo não o traduz mais, então NÃO EXISTE
   * rótulo para registrar. Sem `rawLabel` na assinatura de propósito — não é um parâmetro que
   * o chamador esqueceu, é um valor que não pode existir aqui (migration 329).
   */
  recordUnreadable(patientId: string): Promise<void>;
}

export class ClickUpDiagnosisRejectionRepository implements ClickUpDiagnosisRejectionPort {
  private poolMemo: Pool | undefined;

  constructor(private readonly source: string = 'clickup') {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Uma linha por (paciente, rótulo) — re-sync do MESMO rótulo desconhecido incrementa
   * `occurrences` em vez de acumular linha nova (mesmo índice único da migration 304).
   */
  async recordUnmapped(patientId: string, rawLabel: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO patient_source_label_rejections
         (patient_id, field_name, raw_label, reason, source)
       VALUES ($1, $2, $3, 'unmapped', $4)
       ON CONFLICT (patient_id, field_name, raw_label, reason) DO UPDATE
         SET occurrences  = patient_source_label_rejections.occurrences + 1,
             rejected_at  = NOW()`,
      [patientId, DIAGNOSIS_FIELD_NAME, rawLabel, this.source],
    );
  }

  /**
   * A OCORRÊNCIA de uma leitura ILEGÍVEL, sem o VALOR — `reason='unreadable'`, `raw_label` NULO.
   *
   * ── POR QUE NÃO GRAVA NADA DO VALOR (a fronteira em que este conserto travou) ─────────────
   * Quando o orderindex de "Tipo de Patología" deixa de resolver, o catálogo não devolveu
   * rótulo nenhum: o único "valor" à mão é o próprio orderindex, que é dado clínico em FORMA
   * CODIFICADA (o ponteiro para a patologia do paciente). Gravá-lo violaria a regra dura de
   * que texto clínico não sai do perímetro; fabricar um sentinela seria inventar dado numa
   * tabela clínica — o oposto do D260 — e colidiria com um rótulo real de mesma grafia. O que
   * a operação precisa para agir já está aqui sem o valor: QUEM (paciente), ONDE (campo), O
   * QUE aconteceu (motivo), QUANDO e QUANTAS VEZES. O motivo ESTRUTURAL fino
   * (`options_unresolved` × `value_not_indexable` × `missing`) sai no evento
   * `clickup_patient_sync.diagnosis_unreadable`, que é metadado de schema e pode ir a log (C1).
   *
   * ── O `ON CONFLICT` MIRA O ÍNDICE PARCIAL DA 329, NÃO O DE 4 COLUNAS ──────────────────────
   * `uq_..._value` inclui `raw_label`, e em btree NULO é DISTINTO de nulo: com rótulo nulo ele
   * não deduplica, o upsert nunca dispararia e cada re-sync deixaria uma linha nova — as "47
   * linhas iguais que afogam o alarme" que a migration 304 existe para impedir. A cláusula
   * `WHERE raw_label IS NULL` é o que infere o índice PARCIAL certo.
   */
  async recordUnreadable(patientId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO patient_source_label_rejections
         (patient_id, field_name, raw_label, reason, source)
       VALUES ($1, $2, NULL, 'unreadable', $3)
       ON CONFLICT (patient_id, field_name, reason) WHERE raw_label IS NULL DO UPDATE
         SET occurrences  = patient_source_label_rejections.occurrences + 1,
             rejected_at  = NOW()`,
      [patientId, DIAGNOSIS_FIELD_NAME, this.source],
    );
  }
}
