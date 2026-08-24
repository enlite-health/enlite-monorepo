import type { PoolClient } from 'pg';
import { PatientClinicalRepository } from '../PatientClinicalRepository';

/**
 * PatientClinicalRepository — SQL emitido pelo upsert.
 * Régua (D211.1, RFC 7396): chave AUSENTE não entra no SET; `null` limpa;
 * `has_consent` só via COALESCE; autoria de additional_comments só quando o
 * campo veio (grava uid, nunca valor); nada além do id → nenhuma query.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

const PATIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function lastCall(): { sql: string; params: unknown[] } {
  const [sql, params] = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1];
  return { sql, params };
}

describe('PatientClinicalRepository.upsert', () => {
  beforeEach(() => { mockPoolQuery.mockReset().mockResolvedValue({ rows: [] }); });

  it('só as chaves PRESENTES entram no SET — editar as observações não toca diagnosis (o defeito de 29/08)', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, additionalComments: 'Texto clínico', actorUid: 'uid-staff-1' });

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const { sql, params } = lastCall();
    expect(sql).not.toMatch(/diagnosis|dependency_level|clinical_segments|service_type|device_type|has_judicial_protection|has_cud|has_consent|clinical_specialty/);
    expect(sql).toMatch(/additional_comments\s+= \$2/);
    expect(sql).toMatch(/additional_comments_updated_at = NOW\(\)/);
    expect(sql).toMatch(/additional_comments_updated_by = \$3/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params).toEqual([PATIENT, 'Texto clínico', 'uid-staff-1']);
  });

  it('additionalComments ausente → autoria NÃO é tocada; diagnosis presente entra', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, diagnosis: 'F84.0', actorUid: 'uid-staff-1' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/diagnosis\s+= \$2/);
    expect(sql).not.toMatch(/additional_comments/);
    expect(params).toEqual([PATIENT, 'F84.0']);
  });

  it('`null` explícito LIMPA (Merge Patch): additionalComments=null grava NULL e registra autoria; sem actor → uid null', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, additionalComments: null, diagnosis: null });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/diagnosis\s+= \$2/);
    expect(sql).toMatch(/additional_comments\s+= \$3/);
    expect(sql).toMatch(/additional_comments_updated_by = \$4/);
    expect(params).toEqual([PATIENT, null, null, null]);
  });

  it('instruções de emergência (D211.2): SET + autoria PRÓPRIA só quando o campo veio; ausente → nada', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, emergencyInstructions: 'Llamar 107', actorUid: 'uid-staff-9' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/emergency_instructions\s+= \$2/);
    expect(sql).toMatch(/emergency_instructions_updated_at = NOW\(\)/);
    expect(sql).toMatch(/emergency_instructions_updated_by = \$3/);
    expect(sql).not.toMatch(/additional_comments/);
    expect(params).toEqual([PATIENT, 'Llamar 107', 'uid-staff-9']);
    mockPoolQuery.mockClear();
    await repo.upsert({ patientId: PATIENT, additionalComments: 'x', actorUid: 'u' });
    expect(lastCall().sql).not.toMatch(/emergency_instructions/);
  });

  it('instruções de emergência SEM actor (escrita sem ator identificado): autoria grava uid NULL, nunca omite a autoria', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, emergencyInstructions: 'Llamar 107' });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/emergency_instructions_updated_at = NOW\(\)/);
    expect(sql).toMatch(/emergency_instructions_updated_by = \$3/);
    expect(params).toEqual([PATIENT, 'Llamar 107', null]);
  });

  it('chaves que o mapper do ClickUp NÃO emite (clinicalSegments, deviceType) ficam AUSENTES → as colunas não são tocadas pelo sync (Merge Patch)', async () => {
    // Espelha o que ClickUpPatientMapper.map entrega hoje (sem clinicalSegments/deviceType);
    // o teste do mapper fixa o lado dele. Se um dia o mapper passar a emitir a chave, este
    // teste continua verde — o que ele fixa é: chave ausente ⇒ coluna intocada.
    const repo = new PatientClinicalRepository();
    await repo.upsert({
      patientId: PATIENT, diagnosis: null, dependencyLevel: null, clinicalSpecialty: null, serviceType: null,
      additionalComments: null, hasJudicialProtection: null, hasCud: null, hasConsent: null, actorUid: null,
    });
    const { sql, params } = lastCall();
    expect(sql).not.toMatch(/clinical_segments|device_type/);
    expect(sql).toMatch(/diagnosis\s+= \$2/);
    expect(sql).toMatch(/additional_comments\s+= \$5/);
    expect(sql).toMatch(/additional_comments_updated_by = \$6/);
    expect(params).toEqual([PATIENT, null, null, null, null, null, null, null, null, null]);
  });

  it('todas as chaves (caminho do sync do ClickUp, D167): tudo entra, na ordem, e has_consent vai por COALESCE', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({
      patientId: PATIENT, diagnosis: 'D', dependencyLevel: 'HIGH' as never, clinicalSegments: null, serviceType: ['AT'] as never,
      deviceType: 'silla', additionalComments: 'obs', hasJudicialProtection: true, hasCud: false, hasConsent: null,
      clinicalSpecialty: 'ASD' as never, actorUid: null,
    });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/has_consent = COALESCE\(\$11, has_consent\)/);
    expect(params).toEqual([PATIENT, 'D', 'HIGH', null, ['AT'], 'silla', 'obs', null, true, false, null, 'ASD']);
    expect(sql).toMatch(/clinical_specialty\s+= \$12/);
    expect(sql).toMatch(/additional_comments_updated_by = \$8/);
  });

  it('clinicalSpecialtyReadable=false (2.2/rodada 4, D167 no DERIVADO): clinical_specialty NÃO entra no SET; null com readable ausente/true GRAVA null (D-E)', async () => {
    const repo = new PatientClinicalRepository();
    // "não consegui ler": a origem mandou algo que o catálogo não traduziu → a coluna fica como está.
    await repo.upsert({ patientId: PATIENT, clinicalSpecialty: null, clinicalSpecialtyReadable: false, diagnosis: 'D' });
    let { sql, params } = lastCall();
    expect(sql).not.toMatch(/clinical_specialty/);
    expect(params).toEqual([PATIENT, 'D']);
    // "vazio legítimo": a origem não preencheu → grava NULL (congelado *parece* dado).
    await repo.upsert({ patientId: PATIENT, clinicalSpecialty: null, clinicalSpecialtyReadable: true });
    ({ sql, params } = lastCall());
    expect(sql).toMatch(/clinical_specialty\s+= \$2/);
    expect(params).toEqual([PATIENT, null]);
    // só a bandeira, sem a chave → nada a gravar (Merge Patch)
    await repo.upsert({ patientId: PATIENT, clinicalSpecialtyReadable: false });
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('hasConsent=false explícito grava false (COALESCE preserva só o null)', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, hasConsent: false });
    const { sql, params } = lastCall();
    expect(sql).toMatch(/has_consent = COALESCE\(\$2, has_consent\)/);
    expect(params).toEqual([PATIENT, false]);
  });

  it('só patientId → nenhuma query (não bate updated_at à toa)', async () => {
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT });
    await repo.upsert({ patientId: PATIENT, actorUid: 'uid-1' });
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('usa o client transacional quando fornecido; serviceType [] vira NULL (migration 139) e null fica null', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    const client = { query: clientQuery } as unknown as PoolClient;
    const repo = new PatientClinicalRepository();
    await repo.upsert({ patientId: PATIENT, serviceType: [], additionalComments: 'x' }, client);
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls[0][1]).toEqual([PATIENT, null, 'x', null]);
    await repo.upsert({ patientId: PATIENT, serviceType: null }, client);
    expect(clientQuery.mock.calls[1][1]).toEqual([PATIENT, null]);
  });

  it('findByPatientId devolve null quando não há linha e mapeia quando há', async () => {
    const repo = new PatientClinicalRepository();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.findByPatientId(PATIENT)).toBeNull();
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ patientId: PATIENT, diagnosis: 'F84', additionalComments: 't' }] });
    const row = await repo.findByPatientId(PATIENT);
    expect(row).toMatchObject({ patientId: PATIENT, diagnosis: 'F84' });
  });
});
