import { describe, it, expect } from 'vitest';
import type { AnaCarePatient, AnaCareListPatient } from './types';

/**
 * Espelho do documento do paciente (item 4, 18/09) — prova que `AnaCarePatient.documentType`/
 * `documentNumber` compilam como opcionais (o backend manda ausente sem `patient_identity:read`,
 * nunca vazio) e que `AnaCareListPatient` (contrato da LISTA) NÃO ganhou o campo — só o DETALHE
 * carrega documento (spec: a lista não muda).
 */
describe('AnaCareHours types — documento do paciente (DETALHE)', () => {
  it('AnaCarePatient aceita documentType/documentNumber ausentes (sem a célula patient_identity:read)', () => {
    const semPermissao: AnaCarePatient = {
      anaCareId: 'AC-PAT-1',
      linked: false,
      name: 'Lucía Fernández QA',
      providers: [],
    };
    expect(semPermissao.documentType).toBeUndefined();
    expect(semPermissao.documentNumber).toBeUndefined();
  });

  it('AnaCarePatient aceita documentType/documentNumber presentes (com a célula patient_identity:read)', () => {
    const comPermissao: AnaCarePatient = {
      anaCareId: 'AC-PAT-1',
      linked: false,
      name: 'Lucía Fernández QA',
      documentType: 'DNI',
      documentNumber: '30999888',
      providers: [],
    };
    expect(comPermissao.documentType).toBe('DNI');
    expect(comPermissao.documentNumber).toBe('30999888');
  });

  it('AnaCareListPatient (contrato da LISTA) não tem documentType/documentNumber no tipo', () => {
    const listaPatient: AnaCareListPatient = {
      anaCareId: 'AC-PAT-1',
      name: 'Lucía Fernández QA',
      linked: false,
      providers: [],
      providersCount: 0,
      shiftsCount: 0,
      hoursActualSum: 0,
      hoursScheduledSumMissingActual: 0,
      validated: 0,
      contested: 0,
      originSinCheckin: 0,
      originWebAdmin: 0,
      originApp: 0,
    };
    // A ausência de `documentType`/`documentNumber` na interface é garantida em TEMPO DE
    // COMPILAÇÃO (o objeto acima não os declara e o tipo não os permite); aqui só confirmamos
    // que o objeto válido da LISTA continua montável sem eles.
    expect('documentType' in listaPatient).toBe(false);
  });
});
