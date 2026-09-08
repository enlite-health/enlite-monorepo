/**
 * TherapeuticProject — a única lógica da entidade é `currentVersion` (spec 017, D299).
 *
 * O resto do arquivo é contrato (interfaces) e as constantes que espelham o backend: o teto do
 * rótulo (migration 415), o teto do texto clínico (416, lex C6) e o mapa `kind → recurso da célula
 * ABAC`. As constantes entram no teste porque um erro nelas é silencioso: um recurso escrito errado
 * aqui não quebra nada — só faz a tela gatear pela célula ERRADA (D286).
 */
import { describe, it, expect } from 'vitest';
import {
  CATALOG_LABEL_MAX,
  THERAPEUTIC_CATALOG_KINDS,
  THERAPEUTIC_CATALOG_RESOURCE,
  THERAPEUTIC_TEXT_MAX,
  currentVersion,
  type TherapeuticProjectVersion,
} from '../TherapeuticProject';

function versao(over: Partial<TherapeuticProjectVersion> = {}): TherapeuticProjectVersion {
  return {
    id: 'v1',
    patientId: 'p1',
    major: 1,
    minor: 0,
    version: 'V.1.0',
    editedFromVersionId: null,
    contractedServiceId: 'svc-1',
    diagnoses: [],
    clinicalContext: 'contexto',
    generalObjective: 'objetivo',
    specificObjectives: [],
    activities: [],
    pathologyTypes: [],
    startDate: '2026-09-01',
    endDate: '2026-12-01',
    annulledAt: null,
    annulledBy: null,
    annulReason: null,
    createdByName: 'Ana',
    createdAt: '2026-09-01T10:00:00.000Z',
    country: 'AR',
    ...over,
  };
}

describe('currentVersion — a versão "em andamento" do card (D299)', () => {
  it('lista vazia devolve null — o card mostra o vazio, não uma versão inventada', () => {
    expect(currentVersion([])).toBeNull();
  });

  it('devolve a mais recente por createdAt, não a primeira do array (Gabriel, 08/09)', () => {
    const antiga = versao({ id: 'antiga', createdAt: '2026-09-01T10:00:00.000Z' });
    const nova = versao({ id: 'nova', createdAt: '2026-09-07T08:00:00.000Z' });
    // De propósito fora de ordem: a API devolve "mais recente primeiro", mas a
    // função não pode DEPENDER disso.
    expect(currentVersion([antiga, nova])?.id).toBe('nova');
    expect(currentVersion([nova, antiga])?.id).toBe('nova');
  });

  it('versão ANULADA fica fora, mesmo sendo a mais recente (lex C5)', () => {
    const viva = versao({ id: 'viva', createdAt: '2026-09-01T10:00:00.000Z' });
    const anulada = versao({
      id: 'anulada',
      createdAt: '2026-09-09T10:00:00.000Z',
      annulledAt: '2026-09-09T11:00:00.000Z',
      annulledBy: 'u1',
      annulReason: 'erro de digitação',
    });
    expect(currentVersion([anulada, viva])?.id).toBe('viva');
  });

  it('TODAS anuladas devolve null — anular a última não deixa uma versão fantasma no card', () => {
    expect(currentVersion([versao({ annulledAt: '2026-09-09T11:00:00.000Z' })])).toBeNull();
  });

  it('não muta o array recebido (a ordenação é sobre uma cópia)', () => {
    const a = versao({ id: 'a', createdAt: '2026-09-01T10:00:00.000Z' });
    const b = versao({ id: 'b', createdAt: '2026-09-07T10:00:00.000Z' });
    const entrada = [a, b];
    currentVersion(entrada);
    expect(entrada.map((v) => v.id)).toEqual(['a', 'b']);
  });
});

describe('constantes espelhadas do backend', () => {
  it('os 3 kinds do catálogo — uma TELA e uma CÉLULA por lista (D286, decisão do Gabriel 08/09)', () => {
    expect(THERAPEUTIC_CATALOG_KINDS).toEqual(['specific-objectives', 'activities', 'pathology-types']);
  });

  it('cada kind aponta para o recurso ABAC do backend (`THERAPEUTIC_CATALOG_RESOURCE`)', () => {
    expect(THERAPEUTIC_CATALOG_RESOURCE).toEqual({
      'specific-objectives': 'catalog_therapeutic_objectives',
      activities: 'catalog_therapeutic_activities',
      'pathology-types': 'catalog_pathology_types',
    });
    // Todo kind declarado tem recurso — senão a tela gatearia por `undefined`.
    for (const kind of THERAPEUTIC_CATALOG_KINDS) {
      expect(THERAPEUTIC_CATALOG_RESOURCE[kind]).toBeTruthy();
    }
  });

  it('os tetos espelham os CHECK das migrations 415 e 416 (lex C6)', () => {
    expect(CATALOG_LABEL_MAX).toBe(200);
    expect(THERAPEUTIC_TEXT_MAX).toBe(4000);
  });
});
