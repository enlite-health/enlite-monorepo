import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancySocialLinksCard } from '../VacancySocialLinksCard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getSocialLinksStats: vi.fn().mockResolvedValue({}),
    generateSocialLink: vi.fn(),
  },
}));

const baseProps = {
  vacancyId: 'v1',
  caseNumber: 748,
  vacancyNumber: 3,
  socialShortLinks: null as Record<string, string> | null,
  onRefresh: vi.fn(),
};

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('VacancySocialLinksCard', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.getSocialLinksStats).mockReset().mockResolvedValue({});
    vi.mocked(AdminApiService.generateSocialLink).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('sem caseNumber: mostra o aviso e os botões "gerar" ficam desabilitados', () => {
    render(<VacancySocialLinksCard {...baseProps} caseNumber={null} />);
    expect(screen.getByText('admin.vacancyDetail.socialLinksCard.noCaseNumber')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /generate/ })[0]).toBeDisabled();
  });

  it('com caseNumber: gerar link chama generateSocialLink e mostra o resultado', async () => {
    vi.mocked(AdminApiService.generateSocialLink).mockResolvedValue({
      social_short_links: { facebook: { url: 'https://short/fb', id: '1' } },
    } as never);
    render(<VacancySocialLinksCard {...baseProps} />);
    const [firstGenerate] = screen.getAllByRole('button', { name: /generate/ });
    fireEvent.click(firstGenerate);
    await waitFor(() => expect(AdminApiService.generateSocialLink).toHaveBeenCalledWith('v1', 'facebook'));
    expect(baseProps.onRefresh).toHaveBeenCalled();
    expect(await screen.findByDisplayValue('https://short/fb')).toBeInTheDocument();
  });

  it('gerar link: erro mostra a mensagem', async () => {
    vi.mocked(AdminApiService.generateSocialLink).mockRejectedValue(new Error('falhou ao gerar'));
    render(<VacancySocialLinksCard {...baseProps} />);
    const [firstGenerate] = screen.getAllByRole('button', { name: /generate/ });
    fireEvent.click(firstGenerate);
    expect(await screen.findByText('falhou ao gerar')).toBeInTheDocument();
  });

  it('link existente: copiar e clicar no ícone externo', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(
      <VacancySocialLinksCard
        {...baseProps}
        socialShortLinks={{ facebook: 'https://short/legacy-fb' }}
      />,
    );
    await waitFor(() => expect(AdminApiService.getSocialLinksStats).toHaveBeenCalledWith('v1'));
    fireEvent.click(screen.getByTitle('admin.vacancyDetail.socialLinksCard.copy'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://short/legacy-fb'));
  });

  it('estatísticas de cliques: exibe a contagem por canal', async () => {
    vi.mocked(AdminApiService.getSocialLinksStats).mockResolvedValue({ facebook: { clicks: 7 } } as never);
    render(<VacancySocialLinksCard {...baseProps} socialShortLinks={{ facebook: 'https://short/fb' }} />);
    expect(await screen.findByText('7')).toBeInTheDocument();
  });

  it('D269 — enforcement=on sem vacancy:write: nenhum botão "gerar" existe, mesmo com caseNumber', () => {
    comEnforcement([], 'on');
    render(<VacancySocialLinksCard {...baseProps} />);
    expect(screen.queryAllByRole('button', { name: /generate/ })).toHaveLength(0);
  });

  it('D269 — enforcement=on com vacancy:write: os botões "gerar" existem', () => {
    comEnforcement(['vacancy:create'], 'on');
    render(<VacancySocialLinksCard {...baseProps} />);
    expect(screen.getAllByRole('button', { name: /generate/ }).length).toBeGreaterThan(0);
  });
});
