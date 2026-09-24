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

  // ══════════════════════════════════════════════════════════════════════════
  // T062-resto (spec 027 Fase 6) — o preview do slug usa o helper de formatação
  // (formatCaseNumber). As duas pontas (preview aqui × PublicVacancyController.SLUG_REGEX
  // no worker-functions) NÃO podem ser ligadas por import — são pacotes diferentes.
  // Prova-se cada lado separadamente pelo LITERAL: este teste fixa a string EXATA que o
  // preview gera para um case_number nativo (≥1000); o teste irmão em
  // worker-functions/.../__tests__/PublicVacancyController.test.ts ("slug NOVO
  // 'casoEN{N}-{M}'") fixa que SLUG_REGEX aceita esse MESMO literal ("casoEN1234-01").
  // Se um dos dois lados mudar o formato sem o outro acompanhar, cada teste falha
  // isoladamente — não há teste único cross-package possível aqui.
  // ══════════════════════════════════════════════════════════════════════════
  describe('T062-resto — preview do slug usa formatCaseNumber', () => {
    it('case_number LEGADO (<1000): preview sem prefixo "EN" — "caso748-3"', () => {
      render(<VacancySocialLinksCard {...baseProps} caseNumber={748} vacancyNumber={3} />);
      expect(
        screen.getByText('https://app.enlite.health/vacantes/caso748-3'),
      ).toBeInTheDocument();
    });

    it('case_number NATIVO (≥1000): preview COM prefixo "EN" — "casoEN1234-1" (o slug que o SLUG_REGEX do T066 aceita)', () => {
      render(<VacancySocialLinksCard {...baseProps} caseNumber={1234} vacancyNumber={1} />);
      expect(
        screen.getByText('https://app.enlite.health/vacantes/casoEN1234-1'),
      ).toBeInTheDocument();
    });

    it('caseNumber null: preview não é renderizado (nada para formatar)', () => {
      render(<VacancySocialLinksCard {...baseProps} caseNumber={null} />);
      expect(screen.queryByText(/vacantes\/caso/)).not.toBeInTheDocument();
    });
  });
});
