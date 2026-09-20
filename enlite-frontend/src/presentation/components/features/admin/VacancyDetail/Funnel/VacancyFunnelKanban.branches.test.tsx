/**
 * VacancyFunnelKanban.branches.test.tsx
 *
 * Cobre os ramos que o teste de resend (VacancyFunnelKanban.resend.test.tsx) não toca:
 * - botão de refresh (refetch)
 * - RefreshCw com classe animate-spin + spinner de "carregando sem data ainda"
 * - banner vermelho de erro do fetch
 * - banner âmbar de moveError: WORKER_NOT_ELIGIBLE (com e sem workerStatus) vs erro genérico
 * - botão de fechar o banner de moveError (limpa o estado)
 * - handlers de mover/rejeitar/desfazer-rejeição repassados ao KanbanBoard
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const refetch = vi.fn().mockResolvedValue(undefined);
const moveEncuadre = vi.fn();
const rejectBlocked = vi.fn();
const unrejectBlocked = vi.fn();
const promoteBlocked = vi.fn();

interface MockHookState {
  data: { stages: Record<string, unknown>; totalEncuadres: number } | null;
  isLoading: boolean;
  error: string | null;
}

let mockState: MockHookState = { data: null, isLoading: false, error: null };

vi.mock('@hooks/admin/useWJAFunnel', () => ({
  useWJAFunnel: () => ({
    data: mockState.data,
    isLoading: mockState.isLoading,
    error: mockState.error,
    refetch,
    moveEncuadre,
    rejectBlocked,
    unrejectBlocked,
    promoteBlocked,
  }),
}));

// O board vira botões que disparam cada handler repassado pelo componente.
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoard', () => ({
  KanbanBoard: ({
    onMove,
    onRejectBlocked,
    onUnrejectBlocked,
    onPromoteBlocked,
  }: {
    onMove: (encuadreId: string, targetStage: string) => Promise<unknown>;
    onRejectBlocked: (blockedId: string, category: string) => Promise<unknown>;
    onUnrejectBlocked: (blockedId: string) => Promise<unknown>;
    onPromoteBlocked?: (blockedId: string) => Promise<string | null>;
  }): ReactNode => (
    <div data-testid="fake-board">
      <button
        data-testid="fake-promote"
        onClick={async () => {
          const msg = await onPromoteBlocked!('blk-eligible');
          document.title = String(msg);
        }}
      >
        promote
      </button>
      <button data-testid="fake-move" onClick={() => onMove('enc-1', 'REJECTED')}>
        move
      </button>
      <button data-testid="fake-reject" onClick={() => onRejectBlocked('blk-1', 'WORKER_DECLINED')}>
        reject
      </button>
      <button data-testid="fake-unreject" onClick={() => onUnrejectBlocked('blk-1')}>
        unreject
      </button>
    </div>
  ),
}));

import { VacancyFunnelKanban } from './VacancyFunnelKanban';

function withBoardData(): MockHookState {
  return { data: { stages: {}, totalEncuadres: 3 }, isLoading: false, error: null };
}

describe('VacancyFunnelKanban — branches', () => {
  beforeEach(() => {
    refetch.mockClear();
    moveEncuadre.mockReset();
    rejectBlocked.mockReset();
    unrejectBlocked.mockReset();
    promoteBlocked.mockReset();
    mockState = { data: null, isLoading: false, error: null };
  });

  it('botão de refresh dispara refetch', () => {
    mockState = withBoardData();
    render(<VacancyFunnelKanban vacancyId="vac-1" />);
    fireEvent.click(screen.getByText('admin.vacancyDetail.funnelView.kanban.refresh'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('isLoading=true sem data: RefreshCw gira e mostra o spinner de carregamento', () => {
    mockState = { data: null, isLoading: true, error: null };
    const { container } = render(<VacancyFunnelKanban vacancyId="vac-1" />);
    // Ícone do refresh + spinner do "carregando sem dado ainda" — ambos usam animate-spin.
    expect(container.querySelectorAll('.animate-spin').length).toBeGreaterThanOrEqual(2);
  });

  it('isLoading=false: RefreshCw NÃO gira', () => {
    mockState = withBoardData();
    const { container } = render(<VacancyFunnelKanban vacancyId="vac-1" />);
    expect(container.querySelectorAll('.animate-spin').length).toBe(0);
  });

  it('error truthy: mostra o banner vermelho com a mensagem', () => {
    mockState = { data: null, isLoading: false, error: 'Falha ao carregar o funil' };
    render(<VacancyFunnelKanban vacancyId="vac-1" />);
    expect(screen.getByText('Falha ao carregar o funil')).toBeInTheDocument();
  });

  it('moveError WORKER_NOT_ELIGIBLE com workerStatus: título e motivo específicos, fechar limpa o banner', async () => {
    mockState = withBoardData();
    moveEncuadre.mockResolvedValue({
      message: 'não apto',
      code: 'WORKER_NOT_ELIGIBLE',
      reason: 'INCOMPLETE_DOCS',
      workerStatus: 'PENDING',
    });
    render(<VacancyFunnelKanban vacancyId="vac-1" />);

    fireEvent.click(screen.getByTestId('fake-move'));

    await waitFor(() => expect(screen.getByTestId('kanban-move-error')).toBeInTheDocument());
    expect(screen.getByText('admin.vacancyDetail.funnelView.kanban.workerNotEligibleTitle')).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.funnelView.kanban.workerEligibilityReason.INCOMPLETE_DOCS'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('common.dismiss'));
    expect(screen.queryByTestId('kanban-move-error')).not.toBeInTheDocument();
  });

  it('moveError WORKER_NOT_ELIGIBLE sem workerStatus: ainda mostra o motivo', async () => {
    mockState = withBoardData();
    moveEncuadre.mockResolvedValue({
      message: 'não apto',
      code: 'WORKER_NOT_ELIGIBLE',
      reason: 'MISSING_PROFILE',
      workerStatus: null,
    });
    render(<VacancyFunnelKanban vacancyId="vac-1" />);

    fireEvent.click(screen.getByTestId('fake-move'));

    await waitFor(() =>
      expect(
        screen.getByText('admin.vacancyDetail.funnelView.kanban.workerEligibilityReason.MISSING_PROFILE'),
      ).toBeInTheDocument(),
    );
  });

  it('moveError genérico (code diferente de WORKER_NOT_ELIGIBLE): título e message genéricos', async () => {
    mockState = withBoardData();
    moveEncuadre.mockResolvedValue({ message: 'Falha ao mover o encuadre' });
    render(<VacancyFunnelKanban vacancyId="vac-1" />);

    fireEvent.click(screen.getByTestId('fake-move'));

    await waitFor(() =>
      expect(screen.getByText('admin.vacancyDetail.funnelView.kanban.moveErrorTitle')).toBeInTheDocument(),
    );
    expect(screen.getByText('Falha ao mover o encuadre')).toBeInTheDocument();
  });

  it('handleRejectBlocked: repassa id+categoria e atualiza o moveError (sucesso = null → sem banner)', async () => {
    mockState = withBoardData();
    rejectBlocked.mockResolvedValue(null);
    render(<VacancyFunnelKanban vacancyId="vac-1" />);

    fireEvent.click(screen.getByTestId('fake-reject'));

    await waitFor(() => expect(rejectBlocked).toHaveBeenCalledWith('blk-1', 'WORKER_DECLINED'));
    expect(screen.queryByTestId('kanban-move-error')).not.toBeInTheDocument();
  });

  it('handleUnrejectBlocked: repassa o id e mostra o banner quando falha', async () => {
    mockState = withBoardData();
    unrejectBlocked.mockResolvedValue({ message: 'não foi possível restaurar' });
    render(<VacancyFunnelKanban vacancyId="vac-1" />);

    fireEvent.click(screen.getByTestId('fake-unreject'));

    await waitFor(() => expect(unrejectBlocked).toHaveBeenCalledWith('blk-1'));
    await waitFor(() => expect(screen.getByText('não foi possível restaurar')).toBeInTheDocument());
  });

  // D300 — o handler traduz o motivo do backend para a frase que a recrutadora lê.
  // O valor volta para o CARD (não para o banner do topo): a ação é de uma tarjeta,
  // e o erro tem de aparecer onde ela clicou.

  it('promover com sucesso devolve null ao card', async () => {
    mockState = withBoardData();
    promoteBlocked.mockResolvedValue(null);
    render(<VacancyFunnelKanban vacancyId="v" />);

    fireEvent.click(screen.getByTestId('fake-promote'));

    await waitFor(() => expect(document.title).toBe('null'));
    expect(promoteBlocked).toHaveBeenCalledWith('blk-eligible');
  });

  it('recusa com reason vira a chave traduzida daquele motivo', async () => {
    mockState = withBoardData();
    promoteBlocked.mockResolvedValue({ message: 'x', reason: 'vacancy_invalid' });
    render(<VacancyFunnelKanban vacancyId="v" />);

    fireEvent.click(screen.getByTestId('fake-promote'));

    await waitFor(() => expect(document.title).toBe('admin.kanban.promoteError.vacancy_invalid'));
  });

  it('sem reason, cai no code', async () => {
    mockState = withBoardData();
    promoteBlocked.mockResolvedValue({ message: 'x', code: 'wja_already_exists' });
    render(<VacancyFunnelKanban vacancyId="v" />);

    fireEvent.click(screen.getByTestId('fake-promote'));

    await waitFor(() => expect(document.title).toBe('admin.kanban.promoteError.wja_already_exists'));
  });

  it('sem reason nem code, cai em unknown — a tela nunca fica muda', async () => {
    mockState = withBoardData();
    promoteBlocked.mockResolvedValue({ message: 'falhou' });
    render(<VacancyFunnelKanban vacancyId="v" />);

    fireEvent.click(screen.getByTestId('fake-promote'));

    await waitFor(() => expect(document.title).toBe('admin.kanban.promoteError.unknown'));
  });
});

