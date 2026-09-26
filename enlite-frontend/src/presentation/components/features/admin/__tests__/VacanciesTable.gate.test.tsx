import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacanciesTable, VacancyRow } from '../VacanciesTable';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const draftRow: VacancyRow = {
  id: 'v1',
  caso: 'Caso 1',
  status: 'Esperando Ativação',
  priority: 'NORMAL',
  diasAberto: '01',
  stageCounts: { INVITED: 1 },
  postulados: '1',
  faltantes: '1',
  isDraft: true,
};

const publishedRow: VacancyRow = { ...draftRow, id: 'v2', isDraft: false };

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

// Fase 3 (completar-vacante-em-rascunho, D425/F25) — o lápis (`edit-vacancy-${id}`) e o
// `VacancyModal` antigo SAÍRAM da lista, para linha em rascunho e publicada, com ou sem
// `vacancy:update`: quem decide o destino do clique agora é `AdminVacanciesPage.tsx`
// (bifurca por permissão só para rascunho, via `onRowClick(id, isDraft)`).
describe('VacanciesTable — clique na linha decide o destino (lápis removido, F25)', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('lápis NÃO existe na árvore mesmo com enforcement=on e vacancy:update concedido', () => {
    comEnforcement(['vacancy:update'], 'on');
    render(<VacanciesTable vacancies={[draftRow, publishedRow]} onRowClick={vi.fn()} />);
    expect(screen.queryByTestId(`edit-vacancy-${draftRow.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`edit-vacancy-${publishedRow.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-modal')).not.toBeInTheDocument();
  });

  it('clicar na linha em rascunho chama onRowClick(id, true) — quem decide modal × navegação direta é o pai', () => {
    const onRowClick = vi.fn();
    render(<VacanciesTable vacancies={[draftRow]} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText(draftRow.caso));
    expect(onRowClick).toHaveBeenCalledWith(draftRow.id, true);
  });

  it('clicar na linha publicada chama onRowClick(id, false)', () => {
    const onRowClick = vi.fn();
    render(<VacanciesTable vacancies={[publishedRow]} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByText(publishedRow.caso));
    expect(onRowClick).toHaveBeenCalledWith(publishedRow.id, false);
  });
});
