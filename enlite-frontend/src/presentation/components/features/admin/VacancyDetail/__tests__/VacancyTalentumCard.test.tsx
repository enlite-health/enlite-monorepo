import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VacancyTalentumCard } from '../VacancyTalentumCard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPrescreeningConfig: vi.fn(),
    generateAIContent: vi.fn(),
    publishToTalentum: vi.fn(),
    unpublishFromTalentum: vi.fn(),
  },
}));

const baseProps = {
  vacancyId: 'v1',
  talentumProjectId: null as string | null,
  talentumWhatsappUrl: null as string | null,
  talentumSlug: null as string | null,
  talentumPublishedAt: null as string | null,
  talentumDescription: null as string | null,
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

describe('VacancyTalentumCard', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.getPrescreeningConfig).mockResolvedValue({ questions: [{ q: 1 }], faq: [] });
    vi.mocked(AdminApiService.generateAIContent).mockReset();
    vi.mocked(AdminApiService.publishToTalentum).mockReset();
    vi.mocked(AdminApiService.unpublishFromTalentum).mockReset();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('não publicado: mostra "sem descrição" e busca a contagem de perguntas', async () => {
    vi.mocked(AdminApiService.getPrescreeningConfig).mockResolvedValue({ questions: [], faq: [] });
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalledWith('v1'));
    expect(screen.getByText(/noDescription/)).toBeInTheDocument();
  });

  it('regenerar descrição: chama generateAIContent e atualiza o preview', async () => {
    vi.mocked(AdminApiService.generateAIContent).mockResolvedValue({
      description: 'Nova descrição gerada',
      prescreening: { questions: [], faq: [] },
    });
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /regenerate/ }));
    await waitFor(() => expect(AdminApiService.generateAIContent).toHaveBeenCalledWith('v1'));
    expect(await screen.findByText('Nova descrição gerada')).toBeInTheDocument();
    expect(baseProps.onRefresh).toHaveBeenCalled();
  });

  it('regenerar descrição: erro mostra feedback', async () => {
    vi.mocked(AdminApiService.generateAIContent).mockRejectedValue(new Error('falhou'));
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /regenerate/ }));
    expect(await screen.findByText('falhou')).toBeInTheDocument();
  });

  it('D269 — enforcement=on sem vacancy:write: botão "regenerar" NÃO existe', async () => {
    comEnforcement([], 'on');
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /regenerate/ })).not.toBeInTheDocument();
    expect(AdminApiService.generateAIContent).not.toHaveBeenCalled();
  });

  it('switch publicar: chama publishToTalentum após confirmação', async () => {
    vi.mocked(AdminApiService.publishToTalentum).mockResolvedValue(undefined as never);
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(AdminApiService.publishToTalentum).toHaveBeenCalledWith('v1'));
    expect(baseProps.onRefresh).toHaveBeenCalled();
  });

  it('switch publicar: cancelar confirm() não chama a API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch'));
    expect(AdminApiService.publishToTalentum).not.toHaveBeenCalled();
  });

  it('switch publicar: erro mostra feedback', async () => {
    vi.mocked(AdminApiService.publishToTalentum).mockRejectedValue(new Error('publish falhou'));
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('publish falhou')).toBeInTheDocument();
  });

  it('publicado: switch despublica via unpublishFromTalentum', async () => {
    vi.mocked(AdminApiService.unpublishFromTalentum).mockResolvedValue(undefined as never);
    render(<VacancyTalentumCard {...baseProps} talentumProjectId="p1" talentumWhatsappUrl="https://wa.me/x" talentumSlug="slug1" talentumPublishedAt="2026-01-01T00:00:00Z" />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(AdminApiService.unpublishFromTalentum).toHaveBeenCalledWith('v1'));
  });

  it('publicado: erro ao despublicar mostra feedback', async () => {
    vi.mocked(AdminApiService.unpublishFromTalentum).mockRejectedValue(new Error('unpublish falhou'));
    render(<VacancyTalentumCard {...baseProps} talentumProjectId="p1" talentumWhatsappUrl="https://wa.me/x" />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('unpublish falhou')).toBeInTheDocument();
  });

  it('D269 — enforcement=on sem talentum:write: o switch (e a linha inteira) NÃO existe', async () => {
    comEnforcement([], 'on');
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.vacancyDetail.talentumCard.publishSwitch')).not.toBeInTheDocument();
    expect(AdminApiService.publishToTalentum).not.toHaveBeenCalled();
  });

  it('D269 — enforcement=on com talentum:write: switch existe', async () => {
    comEnforcement(['talentum:update'], 'on');
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('publicado: copiar link do WhatsApp', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<VacancyTalentumCard {...baseProps} talentumProjectId="p1" talentumWhatsappUrl="https://wa.me/x" />);
    await waitFor(() => expect(AdminApiService.getPrescreeningConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('admin.vacancyDetail.talentumCard.copyLink'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://wa.me/x'));
    expect(screen.getByText(/copied/)).toBeInTheDocument();
  });

  it('sem perguntas cadastradas: switch fica desabilitado por falta de perguntas', async () => {
    vi.mocked(AdminApiService.getPrescreeningConfig).mockResolvedValue({ questions: [], faq: [] });
    render(<VacancyTalentumCard {...baseProps} />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeDisabled());
  });
});
