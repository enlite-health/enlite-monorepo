import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancyMeetLinksCard } from '../VacancyMeetLinksCard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { updateVacancyMeetLinks: vi.fn() },
}));

const baseProps = {
  vacancyId: 'v1',
  meetLink1: null as string | null,
  meetDatetime1: null as string | null,
  meetLink2: null as string | null,
  meetDatetime2: null as string | null,
  meetLink3: null as string | null,
  meetDatetime3: null as string | null,
  onSaved: vi.fn(),
};

const VALID = 'https://meet.google.com/abc-defg-hij';

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacancyMeetLinksCard', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.updateVacancyMeetLinks).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('renderiza os 3 links vazios, sem badge de data e sem link externo', () => {
    render(<VacancyMeetLinksCard {...baseProps} />);
    expect(screen.getAllByPlaceholderText('https://meet.google.com/xxx-xxxx-xxx')).toHaveLength(3);
    expect(screen.queryByTitle('admin.vacancyDetail.meetLinksCard.openLink')).not.toBeInTheDocument();
  });

  it('link + data preenchidos: mostra o badge formatado e o link externo', () => {
    render(<VacancyMeetLinksCard {...baseProps} meetLink1={VALID} meetDatetime1="2026-03-01T14:00:00Z" />);
    expect(screen.getByTitle('admin.vacancyDetail.meetLinksCard.openLink')).toBeInTheDocument();
  });

  it('digitar link inválido e salvar: mostra erro de validação, NÃO chama a API', async () => {
    render(<VacancyMeetLinksCard {...baseProps} />);
    const [input] = screen.getAllByPlaceholderText('https://meet.google.com/xxx-xxxx-xxx');
    fireEvent.change(input, { target: { value: 'https://zoom.us/x' } });
    fireEvent.click(screen.getByRole('button', { name: /saveLinks/ }));
    expect(await screen.findByText('admin.vacancyDetail.meetLinksCard.invalidLink')).toBeInTheDocument();
    expect(AdminApiService.updateVacancyMeetLinks).not.toHaveBeenCalled();
  });

  it('corrigir o link limpa o erro anterior', async () => {
    render(<VacancyMeetLinksCard {...baseProps} />);
    const [input] = screen.getAllByPlaceholderText('https://meet.google.com/xxx-xxxx-xxx');
    fireEvent.change(input, { target: { value: 'inválido' } });
    fireEvent.click(screen.getByRole('button', { name: /saveLinks/ }));
    await screen.findByText('admin.vacancyDetail.meetLinksCard.invalidLink');
    fireEvent.change(input, { target: { value: VALID } });
    expect(screen.queryByText('admin.vacancyDetail.meetLinksCard.invalidLink')).not.toBeInTheDocument();
  });

  it('salvar com link válido (ou vazio): chama updateVacancyMeetLinks e onSaved', async () => {
    vi.mocked(AdminApiService.updateVacancyMeetLinks).mockResolvedValue({} as never);
    render(<VacancyMeetLinksCard {...baseProps} />);
    const [input] = screen.getAllByPlaceholderText('https://meet.google.com/xxx-xxxx-xxx');
    fireEvent.change(input, { target: { value: VALID } });
    fireEvent.click(screen.getByRole('button', { name: /saveLinks/ }));
    await waitFor(() => expect(AdminApiService.updateVacancyMeetLinks).toHaveBeenCalledWith('v1', [VALID, null, null]));
    expect(baseProps.onSaved).toHaveBeenCalled();
    expect(await screen.findByText('admin.vacancyDetail.meetLinksCard.saveSuccess')).toBeInTheDocument();
  });

  it('salvar: erro da API mostra a mensagem de feedback', async () => {
    vi.mocked(AdminApiService.updateVacancyMeetLinks).mockRejectedValue(new Error('falhou ao salvar'));
    render(<VacancyMeetLinksCard {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /saveLinks/ }));
    expect(await screen.findByText('falhou ao salvar')).toBeInTheDocument();
  });

  it('D269 — enforcement=on sem vacancy:write: botão "salvar" NÃO existe', () => {
    comEnforcement([], 'on');
    render(<VacancyMeetLinksCard {...baseProps} />);
    expect(screen.queryByRole('button', { name: /saveLinks/ })).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com vacancy:write: botão "salvar" existe', () => {
    comEnforcement(['vacancy:write'], 'on');
    render(<VacancyMeetLinksCard {...baseProps} />);
    expect(screen.getByRole('button', { name: /saveLinks/ })).toBeInTheDocument();
  });
});
