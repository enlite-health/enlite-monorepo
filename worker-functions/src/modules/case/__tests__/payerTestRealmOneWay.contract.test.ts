/**
 * Trava de MÃO ÚNICA do pagador de teste (spec 077, D672; migration 585 por cima da 584, que entrou simétrica pela D671).
 *
 * O sentido da regra mora só no SQL de `fn_077_payer_realm_matches_patient`, que os 2 triggers da 584 e o PUT de cobertura
 * (`PatientInsuranceVerifiedRepository.replaceCodesForPatient`) leem pelo nome; o comportamento é provado no banco real
 * (`tests/e2e/077-pagador-realm.e2e.test.ts`, no CI). Este teste morre se a definição VIGENTE da função (a da migration de
 * maior número que a define) deixar de ser a de mão única, ou se o ROLLBACK_585 deixar de devolver o corpo literal da 584.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIG = path.resolve(__dirname, '../../../../migrations');
const DEF = /CREATE OR REPLACE FUNCTION fn_077_payer_realm_matches_patient\(p_patient_id uuid, p_provider_code text\)[\s\S]*?\$\$;/;
const ler = (f: string): string => fs.readFileSync(path.join(MIG, f), 'utf8');
const definicao = (sql: string): string => {
  const m = DEF.exec(sql);
  if (!m) throw new Error('fn_077_payer_realm_matches_patient não encontrada');
  return m[0];
};

describe('trava de mão única do pagador de teste (D672, migration 585)', () => {
  it('T-F2a-86 a definição vigente de fn_077_payer_realm_matches_patient é a da 585 e recusa só pagador de teste em paciente real', () => {
    const comDef = fs.readdirSync(MIG).filter((f) => /^\d{3}_.*\.sql$/.test(f) && DEF.test(ler(f))).sort();
    expect(comDef).toEqual(['584_payer_test_realm_guard.sql', '585_payer_test_realm_one_way.sql']);
    const vigente = definicao(ler(comDef[comDef.length - 1]));
    expect(vigente).toContain('OR NOT COALESCE((SELECT p.is_test FROM insurance_providers p WHERE p.code = p_provider_code), false)');
    expect(vigente).toContain('OR COALESCE((SELECT pa.is_test FROM patients pa WHERE pa.id = p_patient_id), false)');
    expect(vigente).not.toMatch(/=\s*COALESCE/);
  });

  it('T-F2a-86 o ROLLBACK_585 devolve literalmente o corpo simétrico da 584', () => {
    const d584 = definicao(ler('584_payer_test_realm_guard.sql'));
    expect(d584).toMatch(/=\s*COALESCE/);
    expect(definicao(ler('pending/ROLLBACK_585_payer_test_realm_one_way.sql'))).toBe(d584);
  });
});
