/**
 * ClickUpDiagnosisRejectionRepository — registra rótulo de "Tipo de Patología" SEM
 * mapeamento (spec 016 F4, D260: "o que não mapear fica em LISTA, nunca inventado").
 *
 * Reusa `patient_source_label_rejections` (migration 304) — a mesma tabela que já serve de
 * registro durável para rótulo cru recusado por outro campo (ceiling/blank/duplicate),
 * ampliada na migration 326 com `reason='unmapped'`. Não cria uma segunda tabela para o mesmo
 * conceito ("rótulo que a origem mandou e não bateu em nada conhecido").
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
}
