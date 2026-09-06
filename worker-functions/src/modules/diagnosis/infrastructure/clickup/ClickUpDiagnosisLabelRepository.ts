/**
 * ClickUpDiagnosisLabelRepository — leitor de `clickup_diagnosis_labels` (migration 326, spec
 * 016 F4). ÚNICA classe de produção que sabe o NOME da tabela do mapa; `ClickUpDiagnosisMapper`
 * só conhece o `ClickUpDiagnosisLabelPort`.
 *
 * Devolve a URI OPACA (nunca code/title): quem resolve os campos gravados em
 * `patient_diagnoses` é sempre `RecordPatientDiagnosis` → `TerminologyPort.getByUri`, nunca
 * esta tabela (ver COMMENT da migration 326 — o motivo é o mesmo que fez a D263 rejeitar
 * `concept_parent_uri` desnormalizado: uma URI copiada aqui e outra resolvida ali podem
 * divergir do catálogo em releases diferentes).
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

export interface ClickUpDiagnosisLabelPort {
  /** `null` quando o rótulo não tem mapeamento ativo — nunca lança para "não encontrado". */
  resolve(label: string): Promise<string | null>;
}

export class ClickUpDiagnosisLabelRepository implements ClickUpDiagnosisLabelPort {
  private poolMemo: Pool | undefined;

  constructor(private readonly source: string = 'clickup') {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async resolve(label: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ concept_uri: string }>(
      `SELECT concept_uri FROM clickup_diagnosis_labels WHERE source = $1 AND label = $2 AND active`,
      [this.source, label],
    );
    return rows[0]?.concept_uri ?? null;
  }
}
