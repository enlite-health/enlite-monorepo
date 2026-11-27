/**
 * PatientKanbanCard — semaforo-da-vaga F3: o círculo da PIOR cor do paciente no cabeçalho do card. Null/ausente = nenhum círculo
 * (o "sin vacante" do subcard já diz isso).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from '@infrastructure/i18n/locales/es.json';
import { PatientKanbanCard } from '../PatientKanbanCard';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', resources: { es: { translation: es } }, interpolation: { escapeValue: false }, initImmediate: false });
});

const base: PatientKanbanItem = {
  id: 'p-sem', firstName: 'ana', lastName: 'garcía', caseNumber: 12, dependencyLevel: null,
  status: 'ACTIVE', admissionStatus: 'DONE', responsibleName: null, leadContactEmailMasked: null, leadContactIsResponsible: false,
};
const renderCard = (patient: PatientKanbanItem) => render(<MemoryRouter><PatientKanbanCard patient={patient} /></MemoryRouter>);

describe('PatientKanbanCard — círculo da pior cor', () => {
  it('worstSemaphore red → círculo vermelho SEM número, com a palavra da cor no aria-label, ao lado do selo do caso', () => {
    renderCard({ ...base, worstSemaphore: 'red' });
    const dot = screen.getByTestId('patient-kanban-card-p-sem-semaphore');
    expect(dot).toHaveAttribute('data-color', 'red');
    expect(dot).toHaveAttribute('aria-label', 'Rojo');
    expect(dot.textContent).toBe('');
    expect(dot.parentElement).toContainElement(screen.getByText(/Caso/));
  });

  it.each([null, undefined] as const)('worstSemaphore %s → nenhum círculo', (w) => {
    renderCard({ ...base, worstSemaphore: w });
    expect(screen.queryByTestId('patient-kanban-card-p-sem-semaphore')).not.toBeInTheDocument();
  });
});
