/**
 * PatientKanbanCard.responsible.test.tsx — D249
 *
 * A identidade do card tem QUATRO níveis, e a ordem entre eles é o teste:
 *   1. contato mascarado — só chega para ficha com o placeholder pré-D249;
 *   2. nome do paciente;
 *   3. traço + "Responsável: X" — o lead novo "para otra persona";
 *   4. traço sozinho.
 *
 * O nível 1 vem primeiro por um motivo concreto: nas 13 fichas que já estão em
 * produção o `firstName` é literalmente "Solicitante". Se o card tratasse isso
 * como "tem nome", o desempate por e-mail (D228/D231, condições do lex) sumiria
 * da tela sem ninguém perceber.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PatientKanbanCard } from '../PatientKanbanCard';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';


function item(overrides: Partial<PatientKanbanItem> = {}): PatientKanbanItem {
  return {
    id: 'p-1',
    firstName: null,
    lastName: null,
    caseNumber: null,
    dependencyLevel: null,
    status: 'SOLICITANTE',
    responsibleName: null,
    leadContactEmailMasked: null,
    leadContactIsResponsible: false,
    ...overrides,
  };
}

function renderCard(patient: PatientKanbanItem) {
  return render(
    <MemoryRouter>
      <PatientKanbanCard patient={patient} />
    </MemoryRouter>,
  );
}

describe('PatientKanbanCard — identidade (D249)', () => {
  it('lead "para otra persona": traço no título e o responsável embaixo', () => {
    renderCard(item({ responsibleName: 'flavia villagra' }));

    expect(screen.getByTestId('patient-kanban-card-p-1-open')).toHaveTextContent('—');
    expect(screen.getByTestId('patient-kanban-card-p-1-responsible')).toHaveTextContent(
      'Flavia Villagra',
    );
  });

  it('o BANCO guarda minúsculo, a TELA mostra capitalizado — a normalização é de armazenamento', () => {
    // O dado que chega da API é exatamente o que o `splitFullName` gravou.
    renderCard(item({ responsibleName: 'maría de los ángeles pérez' }));

    // E a partícula continua minúscula: "De Los Ángeles" estaria errado.
    expect(screen.getByTestId('patient-kanban-card-p-1-responsible')).toHaveTextContent(
      'María de los Ángeles Pérez',
    );
  });

  it('paciente COM nome: o nome manda e nenhuma linha de responsável aparece', () => {
    renderCard(item({ firstName: 'joaquín', lastName: 'benítez', responsibleName: 'flavia villagra' }));

    expect(screen.getByTestId('patient-kanban-card-p-1-open')).toHaveTextContent('Joaquín Benítez');
    expect(screen.queryByTestId('patient-kanban-card-p-1-responsible')).toBeNull();
  });

  it('ficha pré-D249: o contato mascarado continua sendo o título — NÃO regride', () => {
    renderCard(item({ firstName: 'Solicitante', leadContactEmailMasked: 'jo***@gmail.com' }));

    const titulo = screen.getByTestId('patient-kanban-card-p-1-open');
    expect(titulo).toHaveTextContent('jo***@gmail.com');
    // A palavra repetida não volta a ser o título.
    expect(titulo).not.toHaveTextContent('Solicitante');
    expect(screen.getByTestId('patient-kanban-card-p-1-contact')).toBeInTheDocument();
  });

  it('sem nome, sem responsável e sem contato: traço sozinho, não tela vazia', () => {
    renderCard(item());

    expect(screen.getByTestId('patient-kanban-card-p-1-open')).toHaveTextContent('—');
    expect(screen.queryByTestId('patient-kanban-card-p-1-responsible')).toBeNull();
  });

  it('o nome do responsável NÃO recebe data-clarity-mask — a máscara é do contato', () => {
    renderCard(item({ responsibleName: 'flavia villagra' }));

    // A condição C3 do lex é sobre o CONTATO no título. O nome do responsável é
    // outra decisão (Gabriel, 02/09: em claro, o acesso é controlado por permissão).
    expect(screen.getByTestId('patient-kanban-card-p-1-open')).not.toHaveAttribute(
      'data-clarity-mask',
    );
  });
});
