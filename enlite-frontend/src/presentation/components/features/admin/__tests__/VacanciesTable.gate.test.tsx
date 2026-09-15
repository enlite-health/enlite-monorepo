import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const row: VacancyRow = {
  id: 'v1',
  caso: 'Caso 1',
  status: 'Esperando Ativação',
  priority: 'NORMAL',
  diasAberto: '01',
  convidados: '1',
  postulados: '1',
  confirmados: '1',
  selecionados: '1',
  faltantes: '1',
  isDraft: false,
};

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacanciesTable — lápis de editar vaga (gate)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('PR-8b — enforcement=on sem vacancy:update: lápis NÃO existe na árvore', () => {
    comEnforcement(['vacancy:create'], 'on');
    render(<VacanciesTable vacancies={[row]} onEditClick={vi.fn()} />);
    expect(screen.queryByTestId(`edit-vacancy-${row.id}`)).not.toBeInTheDocument();
  });

  it('PR-8b — enforcement=on com vacancy:update: lápis existe na árvore', () => {
    comEnforcement(['vacancy:update'], 'on');
    render(<VacanciesTable vacancies={[row]} onEditClick={vi.fn()} />);
    expect(screen.getByTestId(`edit-vacancy-${row.id}`)).toBeInTheDocument();
  });

  it('PR-8b — clicar no lápis chama onEditClick(id, isDraft) e não propaga pro onRowClick', () => {
    comEnforcement(['vacancy:update'], 'on');
    const onEditClick = vi.fn();
    const onRowClick = vi.fn();
    render(<VacanciesTable vacancies={[row]} onEditClick={onEditClick} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByTestId(`edit-vacancy-${row.id}`));
    expect(onEditClick).toHaveBeenCalledWith(row.id, row.isDraft);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
