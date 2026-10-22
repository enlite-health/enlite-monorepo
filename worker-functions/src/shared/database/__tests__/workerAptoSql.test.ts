import { aptoWhenCompletedSql, workerAptoSql } from '../workerAptoSql';
import { COMPLETED_COLUMN_STAGES } from '../../../modules/matching/domain/kanbanColumn';

describe('workerAptoSql (spec 067 FR-03) — só chama o dono, não repete regra', () => {
  it('workerAptoSql chama fn_worker_is_apto com a expressão pedida', () => {
    expect(workerAptoSql('w.id')).toBe('fn_worker_is_apto(w.id)');
    expect(workerAptoSql('$1')).toBe('fn_worker_is_apto($1)');
  });

  it('aptoWhenCompletedSql avalia o apto só nas etapas de Completado, interpoladas de COMPLETED_COLUMN_STAGES', () => {
    const sql = aptoWhenCompletedSql('wja.application_funnel_stage', 'wja.worker_id');
    expect(sql).toContain('fn_worker_is_apto(wja.worker_id)');
    expect(sql).toContain('wja.application_funnel_stage IN (');
    for (const stage of COMPLETED_COLUMN_STAGES) expect(sql).toContain(`'${stage}'`);
    expect(COMPLETED_COLUMN_STAGES.length).toBeGreaterThan(0);
    // fora das etapas de Completado a expressão é NULL (CASE sem ELSE)
    expect(sql).not.toMatch(/ELSE/);
  });

  it('nenhuma regra copiada: o SQL emitido não cita coluna de documento nem de cadastro', () => {
    const sql = `${workerAptoSql('w.id')} ${aptoWhenCompletedSql('s', 'w.id')}`;
    expect(sql).not.toMatch(/identity_document|criminal_record|document_validations|first_name|REGISTERED/);
  });
});
