/**
 * matchProfile — spec 096 (DD-1, CA-2): horário (por dia), profissão e sexo, cada um com positivo e negativo.
 * Funções puras: o teste lê o mesmo texto que roda. A prova contra o banco é o e2e de back (T104).
 */
import { matchProfileSql, passesSex, profileApplied } from '../matchProfile';

const OPTS = { jp: 'jp', workerParam: '$2', occupationParam: '$4' };

describe('matchProfileSql — horário', () => {
  it('declarou disponibilidade → exige todo dia do horário efetivo em worker_availability.day_of_week', () => {
    const sql = matchProfileSql({ hasAvailability: true, occupation: null }, OPTS);
    expect(sql).toContain('jsonb_to_recordset(COALESCE(');
    expect(sql).toContain('horario_do_servico(jp.contracted_service_id, CURRENT_DATE) ELSE jp.schedule END');
    expect(sql).toContain('wa.worker_id = $2 AND wa.day_of_week = vd."dayOfWeek"');
    expect(sql).toMatch(/AND NOT EXISTS \(\s+SELECT 1\s+FROM jsonb_to_recordset/);
  });

  it('vaga sem horário passa: COALESCE para lista vazia (0 dias descobertos)', () => {
    expect(matchProfileSql({ hasAvailability: true, occupation: null }, OPTS)).toContain("'[]'::jsonb)) AS vd");
  });

  it('SEM disponibilidade declarada → nenhum predicado de horário (anti-exclusão, como o match)', () => {
    const sql = matchProfileSql({ hasAvailability: false, occupation: null }, OPTS);
    expect(sql).toBe('');
    expect(sql).not.toContain('worker_availability');
  });
});

describe('matchProfileSql — profissão', () => {
  it('casa com a lista efetiva da vaga (param = occupation) e lista vazia passa', () => {
    const sql = matchProfileSql({ hasAvailability: false, occupation: 'AT' }, OPTS);
    expect(sql).toContain("COALESCE(pcs_eff.required_professions, '{}'::text[]) ELSE jp.required_professions END");
    expect(sql).toContain('cardinality(');
    expect(sql).toContain('= 0 OR $4::text = ANY(');
  });

  it('prestador sem profissão (occupation e profession nulos) → não filtra por profissão', () => {
    expect(matchProfileSql({ hasAvailability: false, occupation: null }, OPTS)).toBe('');
  });

  it('os dois critérios juntos viram dois AND', () => {
    const sql = matchProfileSql({ hasAvailability: true, occupation: 'AT' }, OPTS);
    expect(sql.match(/\n\s+AND /g)).toHaveLength(2);
  });
});

describe('passesSex', () => {
  it.each([
    [null, 'FEMALE'], [undefined, null], ['BOTH', 'MALE'], ['', 'FEMALE'], ['qualquer', null],
  ])('vaga %p (sem restrição) passa, prestador %p', (req, w) => {
    expect(passesSex(req, w)).toBe(true);
  });
  it('vaga F + prestadora F passa; vaga M + prestador M passa (variantes de grafia)', () => {
    expect(passesSex('F', 'FEMALE')).toBe(true);
    expect(passesSex('M', 'masculino')).toBe(true);
    expect(passesSex('FEMALE', 'mujer')).toBe(true);
  });
  it('vaga M + prestadora F NÃO passa', () => {
    expect(passesSex('M', 'FEMALE')).toBe(false);
  });
  it('prestador sem sexo é excluído quando a vaga restringe', () => {
    expect(passesSex('F', null)).toBe(false);
    expect(passesSex('M', 'Trans')).toBe(false);
  });
});

describe('profileApplied', () => {
  it('diz quais filtros valeram', () => {
    expect(profileApplied({ hasAvailability: true, occupation: 'AT' })).toEqual({ schedule: true, profession: true, sex: true });
    expect(profileApplied({ hasAvailability: false, occupation: null })).toEqual({ schedule: false, profession: false, sex: true });
  });
});
