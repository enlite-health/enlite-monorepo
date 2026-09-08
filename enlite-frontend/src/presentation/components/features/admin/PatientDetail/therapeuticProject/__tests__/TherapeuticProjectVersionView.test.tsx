/**
 * TherapeuticProjectVersionView — UMA versão em leitura (spec 017 F4).
 *
 * O que estes testes seguram:
 *  · lex C7 — texto clínico e CID chegam `null` com `redacted.clinical` quando falta
 *    `patient_clinical:read`. A tela mostra o RÓTULO de redigido (`tpv-*-redacted`), nunca vazio:
 *    campo em branco leria como "não tem dado", e é "você não pode ver".
 *  · D113 — `null` (não decidido/redigido) ≠ `[]` (tem a célula, lista vazia → `—`).
 *  · lex C6 — o texto clínico renderizado carrega `data-clarity-mask` (o Clarity está vivo em PRD).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';

// ── i18n mock (molde `PatientDetailCards.gate.test.tsx`) ─────────────────────

const translations = ptBR as Record<string, any>;

function t(key: string, optsOrDefault?: any): string {
  const parts = key.split('.');
  let current: any = translations;
  for (const part of parts) current = current?.[part];
  if (typeof current === 'string') {
    if (typeof optsOrDefault === 'object' && optsOrDefault !== null) {
      return current.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => optsOrDefault[k] ?? _);
    }
    return current;
  }
  if (typeof optsOrDefault === 'string') return optsOrDefault;
  return key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

import { TherapeuticProjectVersionView } from '../TherapeuticProjectVersionView';

// ── Insumos ──────────────────────────────────────────────────────────────────

const SERVICO: PatientContractedServiceDetail = {
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 1,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: null,
  hourlyValueRedacted: false,
  startDate: null,
  contractType: null,
  taxCondition: null,
  supervisionFrequency: null,
  guardShift: null,
  providerAgeBand: null,
  addressId: null,
  schedule: null,
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: [],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const VERSAO: TherapeuticProjectVersion = {
  id: 'v1',
  patientId: patientDetailFixture.id,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: 'svc-1',
  contractedServiceCode: 'CAREGIVER',
  modality: 'IN_PERSON',
  diagnoses: [
    { uri: 'urn:icd:1', title: 'Trastorno del espectro autista' },
    { uri: 'urn:icd:2', title: 'TDAH' },
  ],
  clinicalContext: 'Contexto clínico sintético da massa de teste.',
  generalObjective: 'Objetivo geral sintético.',
  specificObjectives: [
    { id: 'so1', label: 'Objetivo 1' },
    { id: 'so2', label: 'Objetivo 2' },
    { id: 'so3', label: 'Objetivo 3' },
    { id: 'so4', label: 'Objetivo 4' },
  ],
  activities: [
    { id: 'ac1', label: 'Atividade 1' },
    { id: 'ac2', label: 'Atividade 2' },
    { id: 'ac3', label: 'Atividade 3' },
    { id: 'ac4', label: 'Atividade 4' },
  ],
  pathologyTypes: [{ id: 'pt1', label: 'Neurológica' }, { id: 'pt2', label: 'Psiquiátrica' }],
  startDate: '2026-09-01',
  endDate: '2026-12-01',
  annulledAt: null,
  annulledByName: null,
  annulReason: null,
  createdByName: 'Ana Fixture',
  createdAt: '2026-09-01T10:00:00Z',
  country: 'AR',
};

const montar = (over: Partial<TherapeuticProjectVersion> = {}, props: { services?: PatientContractedServiceDetail[]; compact?: boolean } = {}) =>
  render(
    <TherapeuticProjectVersionView
      version={{ ...VERSAO, ...over }}
      services={props.services ?? [SERVICO]}
      {...(props.compact === undefined ? {} : { compact: props.compact })}
    />,
  );

const REDIGIDO = ptBR.admin.patients.detail.therapeuticProjectCard.redacted;

// ── Completo × compacto ──────────────────────────────────────────────────────

describe('modo completo (drawer) × compacto (card)', () => {
  it('completo (default): TODOS os itens das listas e texto clínico sem `line-clamp`', () => {
    montar();

    expect(screen.getByTestId('therapeutic-project-version-view').getAttribute('data-version')).toBe('V.1.0');
    expect(screen.getByTestId('tpv-specific').querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByTestId('tpv-activities').querySelectorAll('li')).toHaveLength(4);
    expect(screen.getByTestId('tpv-clinical-text').className).not.toContain('line-clamp-3');
  });

  it('compacto (card): só os 3 primeiros de cada lista e texto clínico com `line-clamp-3`', () => {
    montar({}, { compact: true });

    expect(screen.getByTestId('tpv-specific').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('tpv-activities').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('tpv-clinical-text').className).toContain('line-clamp-3');
    expect(screen.getByTestId('tpv-objective-text').className).toContain('line-clamp-3');
  });

  it('lex C6: o texto clínico renderizado carrega `data-clarity-mask`', () => {
    montar();

    expect(screen.getByTestId('tpv-clinical-text').getAttribute('data-clarity-mask')).toBe('True');
    expect(screen.getByTestId('tpv-objective-text').getAttribute('data-clarity-mask')).toBe('True');
  });

  it('mostra CID, serviço, patologias e prazos em es-AR (`dd/mm/aaaa`)', () => {
    montar();

    expect(screen.getByTestId('tpv-cid').querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Trastorno del espectro autista')).toBeInTheDocument();
    expect(screen.getByTestId('tpv-service')).toHaveTextContent('Acompanhante Terapêutico');
    expect(screen.getByTestId('tpv-modality')).toHaveTextContent(ptBR.admin.patients.detail.therapeuticProjectCard.modalityOptions.IN_PERSON);
    // DEC-09: o tipo de patologia (capítulo CID-11 derivado) é máscara para o Ana Care — NÃO aparece na tela, só no PDF.
    expect(screen.queryByTestId('tpv-pathology')).not.toBeInTheDocument();
    expect(screen.queryByText(/Neurológica/)).not.toBeInTheDocument();
    expect(screen.getByTestId('tpv-deadlines')).toHaveTextContent('01/09/2026 - 01/12/2026');
  });
});

// ── Redigido (lex C7) ────────────────────────────────────────────────────────

describe('🔒 lex C7 — versão redigida mostra o RÓTULO, nunca vazio', () => {
  it('D301 — versão anterior à 417 (`modality: null`) mostra "—" na modalidade', () => {
    render(<TherapeuticProjectVersionView version={{ ...VERSAO, modality: null }} services={[SERVICO]} />);
    expect(screen.getByTestId('tpv-modality')).toHaveTextContent('—');
  });

  it('`redacted.clinical` → CID, contexto e objetivo viram o rótulo de redigido', () => {
    montar({ redacted: { clinical: true }, diagnoses: null, clinicalContext: null, generalObjective: null });

    expect(screen.getByTestId('tpv-clinical-text-redacted')).toHaveTextContent(REDIGIDO);
    expect(screen.getByTestId('tpv-objective-text-redacted')).toHaveTextContent(REDIGIDO);
    expect(screen.getByTestId('tpv-cid')).toHaveTextContent(REDIGIDO);
    // o texto clínico NÃO chega ao DOM em nenhuma forma
    expect(screen.queryByTestId('tpv-clinical-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tpv-objective-text')).not.toBeInTheDocument();
  });

  it('🔴 `redacted.clinical` com texto presente no objeto: a tela AINDA redige (a flag manda)', () => {
    montar({ redacted: { clinical: true } });

    expect(screen.getByTestId('tpv-clinical-text-redacted')).toBeInTheDocument();
    expect(screen.queryByText('Contexto clínico sintético da massa de teste.')).not.toBeInTheDocument();
    expect(screen.getByTestId('tpv-cid')).toHaveTextContent(REDIGIDO);
    expect(screen.queryByText('TDAH')).not.toBeInTheDocument();
  });

  it('`null` SEM a flag (texto/CID não decididos) também mostra o rótulo', () => {
    montar({ diagnoses: null, clinicalContext: null, generalObjective: null });

    expect(screen.getByTestId('tpv-cid')).toHaveTextContent(REDIGIDO);
    expect(screen.getByTestId('tpv-clinical-text-redacted')).toBeInTheDocument();
    expect(screen.getByTestId('tpv-objective-text-redacted')).toBeInTheDocument();
  });
});

// ── D113: `[]` não é `null` ──────────────────────────────────────────────────

describe('🔒 D113 — lista VAZIA mostra `—` (não é o rótulo de redigido)', () => {
  it('CID `[]`, objetivos `[]` e atividades `[]` viram `—`', () => {
    montar({ diagnoses: [], specificObjectives: [], activities: [], pathologyTypes: [] });

    expect(screen.getByTestId('tpv-cid')).toHaveTextContent('—');
    expect(screen.getByTestId('tpv-cid')).not.toHaveTextContent(REDIGIDO);
    expect(screen.getByTestId('tpv-specific')).toHaveTextContent('—');
    expect(screen.getByTestId('tpv-activities')).toHaveTextContent('—');
    expect(screen.getByTestId('tpv-specific').querySelectorAll('li')).toHaveLength(0);
  });
});

// ── Serviço e anulação ───────────────────────────────────────────────────────

describe('serviço desconhecido e versão anulada', () => {
  it('serviço da versão fora da lista da ficha → rótulo "não encontrado", sem quebrar', () => {
    montar({ contractedServiceId: 'svc-fantasma' });

    expect(screen.getByTestId('tpv-service')).toHaveTextContent(ptBR.admin.patients.detail.therapeuticProjectCard.serviceUnknown);
  });

  it('D113 — serviços REDIGIDOS (sem patient_services:read, lista chega []): o rótulo é "sem permissão", nunca "não encontrado"', () => {
    render(<TherapeuticProjectVersionView version={VERSAO} services={[]} servicesRedacted />);
    expect(screen.getByTestId('tpv-service')).toHaveTextContent(ptBR.admin.patients.detail.therapeuticProjectCard.redacted);
    expect(screen.getByTestId('tpv-service')).not.toHaveTextContent(ptBR.admin.patients.detail.therapeuticProjectCard.serviceUnknown);
  });

  it('lista de serviços VAZIA na ficha → mesmo rótulo', () => {
    montar({}, { services: [] });

    expect(screen.getByTestId('tpv-service')).toHaveTextContent(ptBR.admin.patients.detail.therapeuticProjectCard.serviceUnknown);
  });

  it('versão viva NÃO tem a linha de anulação', () => {
    montar();

    expect(screen.queryByTestId('tpv-annulled')).not.toBeInTheDocument();
  });

  it('versão anulada COM motivo: data em es-AR + motivo', () => {
    montar({ annulledAt: '2026-10-15', annulReason: 'Erro de digitação' });

    expect(screen.getByTestId('tpv-annulled')).toHaveTextContent('15/10/2026 · Erro de digitação');
  });

  it('versão anulada SEM motivo: só a data, sem o separador pendurado', () => {
    montar({ annulledAt: '2026-10-15', annulReason: null });

    expect(screen.getByTestId('tpv-annulled')).toHaveTextContent('15/10/2026');
    expect(screen.getByTestId('tpv-annulled')).not.toHaveTextContent('·');
  });
});
