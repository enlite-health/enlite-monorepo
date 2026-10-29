import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DraftVacancyTodoCard } from '../DraftVacancyTodoCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count != null ? `${k}#${o.count}` : k) }),
}));

const base = { required_professions: [], required_sex: null, payment_day: null, required_experience: null };

describe('DraftVacancyTodoCard — 057/T4.4', () => {
  it('com serviço: item único com a contagem e link para a ficha; sem os 4 itens antigos', () => {
    render(
      <MemoryRouter>
        <DraftVacancyTodoCard vacancy={{ ...base, contracted_service_id: 's1', patient_id: 'p-3' }} missing={5} />
      </MemoryRouter>,
    );
    expect(screen.getByText('admin.draftVacancy.todo.serviceRecruitmentFields#5')).toBeInTheDocument();
    expect(screen.queryByText('admin.draftVacancy.todo.paymentDay')).toBeNull();
    expect(screen.getByTestId('draft-todo-service-link')).toHaveAttribute('href', '/admin/patients/p-3?tab=contractedService');
  });

  it('sem serviço: 7 itens, sem link', () => {
    render(
      <MemoryRouter>
        <DraftVacancyTodoCard vacancy={{ ...base }} missing={7} />
      </MemoryRouter>,
    );
    expect(screen.getByText('admin.draftVacancy.todo.paymentDay')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-todo-service-link')).toBeNull();
  });
});
