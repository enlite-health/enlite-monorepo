/**
 * PatientKanbanCard — spec 012, US-B10: com nome colhido (D249) o card identifica o solicitante
 * pelo NOME; nunca pelo literal "Solicitante" e NUNCA por telefone (lex C10.1: sem finalidade
 * declarada, telefone no card é dado excessivo — fora desta rodada).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from '@infrastructure/i18n/locales/es.json';
import { PatientKanbanCard } from '../PatientKanbanCard';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

void i18n.use(initReactI18next).init({ lng: 'es', resources: { es: { translation: es } }, interpolation: { escapeValue: false } });

const base: PatientKanbanItem = {
  id: 'p-nome', firstName: 'ana', lastName: 'garcía', caseNumber: null, dependencyLevel: null,
  status: 'SOLICITANTE', admissionStatus: 'SOLICITANTE', responsibleName: null, leadContactEmailMasked: null, leadContactIsResponsible: false,
};

describe('US-B10 — o card identifica o solicitante', () => {
  it('lead com nome (D249): título é o nome capitalizado, nunca o literal "Solicitante"; nenhum telefone', () => {
    // Fase 1 (cadeia-paciente-vacante-itinerario) juntou SOLICITANTE/ADMISSION/PENDING_ADMISSION
    // numa única coluna "Admisión" — o card passou a mostrar o subestágio (badge própria,
    // `patient-kanban-card-substage`) para não perder a distinção. A garantia que resta aqui é a
    // ORIGINAL (D249): o TÍTULO do card é o nome, nunca o literal "Solicitante".
    const { container } = render(<MemoryRouter><PatientKanbanCard patient={base} /></MemoryRouter>);
    expect(screen.getByTestId('patient-kanban-card-p-nome-open')).toHaveTextContent('Ana García');
    expect(screen.getByTestId('patient-kanban-card-p-nome-open')).not.toHaveTextContent('Solicitante');
    expect(container.textContent).not.toMatch(/\+\d{8,}|\d[\d\s-]{9,}\d/);
  });

  it('lead "para otra persona" (sem nome): traço + Responsable: X — ainda sem telefone', () => {
    const { container } = render(<MemoryRouter><PatientKanbanCard patient={{ ...base, firstName: null, lastName: null, responsibleName: 'marta lopez' }} /></MemoryRouter>);
    expect(screen.getByTestId('patient-kanban-card-p-nome-open')).toHaveTextContent('—');
    expect(screen.getByTestId('patient-kanban-card-p-nome-responsible')).toHaveTextContent('Responsable: Marta Lopez');
    expect(container.textContent).not.toMatch(/\+\d{8,}|\d[\d\s-]{9,}\d/);
  });
});
