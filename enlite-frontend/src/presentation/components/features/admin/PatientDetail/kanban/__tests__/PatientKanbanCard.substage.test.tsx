/**
 * PatientKanbanCard.substage.test.tsx — Fase 1 (change cadeia-paciente-vacante-itinerario).
 *
 * A coluna "admisión" do board junta SOLICITANTE/ADMISSION/PENDING_ADMISSION (ver
 * `usePatientKanban.ts`, ADMISSION_GROUP) — sem um sinal por card, os três ficam
 * indistinguíveis dentro da mesma coluna. Este teste prende:
 *   - a badge de subestágio aparece para os 3 status do funil, com o MESMO
 *     vocabulário da coluna (`admin.patients.kanban.columns.<status>`) — inclusive
 *     PENDING_ADMISSION → "Esperando financiero" (o texto que o e2e
 *     `patient-status-aguardando-financeiro.integration.e2e.ts:86` exige visível);
 *   - status fora do funil (ex.: ACTIVE) não mostra a badge;
 *   - i18n REAL (es e pt-BR) — nunca o código cru (`expectNoRawEnumLeaks`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { PatientKanbanCard } from '../PatientKanbanCard';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

beforeAll(async () => {
  // Re-init com os recursos REAIS de es/pt-BR — sem isso a chave cai no fallback (o
  // valor cru) e o teste não pegaria uma chave i18n faltando.
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

function item(overrides: Partial<PatientKanbanItem> = {}): PatientKanbanItem {
  return {
    id: 'p-sub',
    firstName: 'joaquín',
    lastName: 'benítez',
    caseNumber: null,
    dependencyLevel: null,
    status: 'SOLICITANTE',
    admissionStatus: 'SOLICITANTE',
    responsibleName: null,
    leadContactEmailMasked: null,
    leadContactIsResponsible: false,
    ...overrides,
  };
}

function renderCard(patient: PatientKanbanItem) {
  return render(<MemoryRouter><PatientKanbanCard patient={patient} /></MemoryRouter>);
}

describe('PatientKanbanCard — subestágio dentro de "admisión" (es)', () => {
  beforeAll(() => { i18n.changeLanguage('es'); });

  it('SOLICITANTE mostra a badge "Solicitante"', () => {
    const { container } = renderCard(item({ status: 'SOLICITANTE' }));
    expect(screen.getByTestId('patient-kanban-card-substage')).toHaveTextContent('Solicitante');
    expectNoRawEnumLeaks(container);
  });

  it('ADMISSION mostra a badge "Admisión"', () => {
    renderCard(item({ status: 'ADMISSION' }));
    expect(screen.getByTestId('patient-kanban-card-substage')).toHaveTextContent('Admisión');
  });

  it('PENDING_ADMISSION mostra a badge "Esperando financiero" (D195)', () => {
    renderCard(item({ status: 'PENDING_ADMISSION' }));
    expect(screen.getByTestId('patient-kanban-card-substage')).toHaveTextContent('Esperando financiero');
  });

  it('ACTIVE (fora do funil de admisión) não mostra a badge', () => {
    renderCard(item({ status: 'ACTIVE' }));
    expect(screen.queryByTestId('patient-kanban-card-substage')).toBeNull();
  });
});

describe('PatientKanbanCard — subestágio dentro de "admisión" (pt-BR)', () => {
  beforeAll(() => { i18n.changeLanguage('pt-BR'); });

  it('PENDING_ADMISSION mostra a badge "Aguardando financeiro"', () => {
    renderCard(item({ status: 'PENDING_ADMISSION' }));
    expect(screen.getByTestId('patient-kanban-card-substage')).toHaveTextContent('Aguardando financeiro');
  });

  it('ACTIVE não mostra a badge', () => {
    renderCard(item({ status: 'ACTIVE' }));
    expect(screen.queryByTestId('patient-kanban-card-substage')).toBeNull();
  });
});
