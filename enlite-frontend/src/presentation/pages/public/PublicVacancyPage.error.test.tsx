/**
 * PublicVacancyPage.error.test.tsx
 *
 * QA caça, rodada 5, item 3: com onRetry/onCompleteRegistration opcionais
 * no PostularseErrorModal (D1, rodada 4), esquecer de passar um dos dois em
 * /vacantes/:id faz o botão sumir SEM ERRO NENHUM — o TypeScript não acusa
 * (props opcionais), e sem teste ninguém percebe. Este teste é a proteção:
 * falha se "Reintentar" ou "Completar registro" desaparecerem do estado de
 * erro da página pública.
 *
 * Mais barato no padrão da casa: NÃO renderiza a página inteira com dados
 * reais — mocka usePostularseAction pra estado='error' direto (é o hook que
 * decide o estado; a página só repassa) e getVacancy pra uma promise que
 * nunca resolve (o card de vaga não faz parte do que este teste prova).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PublicVacancyPage from './PublicVacancyPage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'vac-1' }),
  useLocation: () => ({ pathname: '/vacantes/vac-1', search: '' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('@infrastructure/http/PublicApiService', () => ({
  PublicApiService: { getVacancy: vi.fn(() => new Promise(() => undefined)) },
  VacancyNotFoundError: class VacancyNotFoundError extends Error {},
}));

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: { trackAcquisitionChannel: vi.fn().mockResolvedValue(undefined) },
}));

const mockPostularse = vi.fn();
const mockDismissModal = vi.fn();
const mockConfirmRegister = vi.fn();

vi.mock('@presentation/hooks/usePostularseAction', () => ({
  usePostularseAction: () => ({
    state: 'error',
    missingFields: null,
    postularse: mockPostularse,
    dismissModal: mockDismissModal,
    confirmRegister: mockConfirmRegister,
  }),
}));

describe('PublicVacancyPage — estado de erro (proteção D1 rodada 5, item 3)', () => {
  it('mostra os DOIS botões — "Reintentar" chama postularse, "Completar registro" chama confirmRegister', () => {
    render(<PublicVacancyPage />);

    const retryBtn = screen.getByRole('button', { name: 'publicVacancy.errorModal.retry' });
    const completeBtn = screen.getByRole('button', { name: 'publicVacancy.errorModal.complete' });
    expect(retryBtn).toBeInTheDocument();
    expect(completeBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(mockPostularse).toHaveBeenCalledTimes(1);

    fireEvent.click(completeBtn);
    expect(mockConfirmRegister).toHaveBeenCalledTimes(1);
  });

  it('mostra o texto PADRÃO (não o bodyHome da home) — /vacantes tem WhatsApp e os dois CTAs, o texto faz sentido aqui', () => {
    render(<PublicVacancyPage />);
    expect(screen.getByText('publicVacancy.errorModal.body')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.bodyHome')).not.toBeInTheDocument();
  });
});
