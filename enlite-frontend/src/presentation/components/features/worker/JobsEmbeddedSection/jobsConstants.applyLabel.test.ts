/**
 * jobsConstants.applyLabel.test.ts
 *
 * Fase 4 de postulacao-documento-pendente (DD5): rótulo dinâmico do botão
 * "Postularse" no card da vaga — usa `buildPendingRows` (a MESMA função
 * que `PendingTasksCard` usa), nunca uma segunda contagem (correção b do
 * orquestrador, 11/09).
 *
 * i18n REAL (es + pt-BR) — o que importa é o TEXTO (voseo, nome do
 * documento/aba), mesmo padrão de `sex-both-i18n.test.tsx`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { buildApplyLabel } from './jobsConstants';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  i18n.changeLanguage('es');
});

describe('buildApplyLabel', () => {
  it('missingFields null (não apurado) → rótulo original "Postularse" (fail-closed)', () => {
    expect(buildApplyLabel(null, 'AT', i18n.t.bind(i18n))).toBe('Postularse');
  });

  it('missingFields=[] (completo) → "Postularse" original', () => {
    expect(buildApplyLabel([], 'AT', i18n.t.bind(i18n))).toBe('Postularse');
  });

  it('1 pendência de DOCUMENTO → "Subí {documento} para postularte"', () => {
    expect(buildApplyLabel(['doc_criminal_record'], 'AT', i18n.t.bind(i18n))).toBe(
      'Subí Antecedentes penales para postularte',
    );
  });

  it('1 pendência de REGISTRO → "Completá {aba} para postularte"', () => {
    expect(buildApplyLabel(['phone'], 'CAREGIVER', i18n.t.bind(i18n))).toBe(
      'Completá Información General para postularte',
    );
  });

  it('token cru worker_documents (fallback, não sabemos qual documento) → continua sendo pendência de DOCUMENTO: "Subí Documentos para postularte"', () => {
    expect(buildApplyLabel(['worker_documents'], 'CAREGIVER', i18n.t.bind(i18n))).toBe(
      'Subí Documentos para postularte',
    );
  });

  it('2+ pendências → "Completá {N} pasos para postularte" — N é o Nº DE LINHAS (agrupadas), nunca o nº de tokens crus', () => {
    // 14 campos gerais (1 linha, mesma aba) + worker_service_areas + worker_availability + 2 docs = 18 tokens crus, 5 linhas.
    const generalTokens = [
      'first_name', 'last_name', 'sex', 'gender', 'birth_date', 'document_number',
      'phone', 'languages', 'profession', 'knowledge_level', 'title_certificate',
      'years_experience', 'experience_types', 'preferred_types',
    ];
    const label = buildApplyLabel(
      [...generalTokens, 'worker_service_areas', 'worker_availability', 'doc_identity_document', 'doc_criminal_record'],
      'CAREGIVER',
      i18n.t.bind(i18n),
    );
    expect(label).toBe('Completá 5 pasos para postularte');
  });

  it('2 pendências (registro + documento) → "Completá 2 pasos para postularte"', () => {
    expect(buildApplyLabel(['phone', 'doc_criminal_record'], 'CAREGIVER', i18n.t.bind(i18n))).toBe(
      'Completá 2 pasos para postularte',
    );
  });

  it('pt-BR: 1 pendência de documento — verbo alinhado com a lista de tarefas ("se candidatar", não "se postular")', () => {
    // Achado do gate (11/09, rodada 3): profile.pendingTasks (lista de
    // tarefas) já dizia "para você se candidatar"; jobs.applyLabel (este
    // rótulo) dizia "para se postular" — dois verbos pra mesma ação, na
    // MESMA tela. Alinhado com o que a lista já usa.
    i18n.changeLanguage('pt-BR');
    expect(buildApplyLabel(['doc_criminal_record'], 'AT', i18n.t.bind(i18n))).toBe(
      'Envie Antecedentes penais para se candidatar',
    );
  });

  it('pt-BR: 2+ pendências — mesmo verbo', () => {
    i18n.changeLanguage('pt-BR');
    expect(buildApplyLabel(['phone', 'doc_criminal_record'], 'CAREGIVER', i18n.t.bind(i18n))).toBe(
      'Complete 2 passos para se candidatar',
    );
  });

  it('pt-BR: missingFields null → "Postularse" (chave jobs.apply, não traduzida — mesmo comportamento ANTES da Fase 4)', () => {
    i18n.changeLanguage('pt-BR');
    expect(buildApplyLabel(null, 'AT', i18n.t.bind(i18n))).toBe(i18n.t('jobs.apply'));
  });
});
