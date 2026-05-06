/**
 * AdminVacanciesSyncButton.test.tsx
 *
 * Testes UNITÁRIOS (comportamento) e VISUAIS (estrutura/animação) do botão
 * "Sincronizar Talentum" com long-press para force sync.
 *
 * Comportamento:
 *   - Clique rápido (mouseDown + mouseUp) → syncFromTalentum() SEM force
 *   - Long press 3s (mouseDown, aguarda 3s) → syncFromTalentum({ force: true })
 *   - Mouse leave durante press → cancela, sem request
 *   - Botão desabilitado durante sync
 *
 * Visual:
 *   - Fill overlay presente com classes corretas
 *   - Transição de width muda conforme isLongPressing
 *   - Conteúdo (ícone + texto) tem z-10 para ficar acima do fill
 *   - Botão tem overflow-hidden, relative, select-none
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminVacanciesPage } from '../AdminVacanciesPage';

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockSyncFromTalentum = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    syncFromTalentum: (...args: unknown[]) => mockSyncFromTalentum(...args),
  },
}));

vi.mock('@hooks/admin/useVacanciesData', () => ({
  useVacanciesData: () => ({
    vacancies: [
      { id: '1', caso: 'Caso 100', status: 'Activo', dependency_level: 'Grave',
        grauColor: 'text-[#f9a000]', convidados: '10', postulados: '5',
        providers_needed: 3, faltantes: '2' },
    ],
    stats: [
      { label: '+7 días', value: '2', icon: 'clock' },
      { label: '+24 días', value: '5', icon: 'clock' },
      { label: 'En selección', value: '10', icon: 'user-check' },
    ],
    total: 1,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
  }),
}));

vi.mock('@presentation/components/features/admin/VacancyFormModal', () => ({
  VacancyFormModal: () => null,
}));

vi.mock('@presentation/components/features/admin/VacancyModal/VacancyModal', () => ({
  VacancyModal: () => null,
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminVacanciesPage />
    </MemoryRouter>,
  );
}

function getSyncButton(): HTMLElement {
  return screen.getByText('admin.vacancies.syncTalentum').closest('button')!;
}

function getFillOverlay(button: HTMLElement): HTMLElement {
  return button.querySelector('.bg-primary\\/15') as HTMLElement;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockSyncFromTalentum.mockResolvedValue({
    total: 1, updated: 1, created: 0, skipped: 0, errors: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTES UNITÁRIOS — Comportamento
// ═══════════════════════════════════════════════════════════════════════════

describe('Sync button — clique rápido (sem force)', () => {
  it('mouseDown + mouseUp rápido chama syncFromTalentum() sem force', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);

    // Flush da promise do handleSyncTalentum
    await act(() => Promise.resolve());

    expect(mockSyncFromTalentum).toHaveBeenCalledTimes(1);
    expect(mockSyncFromTalentum).toHaveBeenCalledWith(undefined);
  });

  it('após sync bem-sucedido exibe mensagem de sucesso', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);

    await act(() => Promise.resolve());

    expect(screen.getByText('1 actualizadas')).toBeInTheDocument();
  });

  it('após sync com erro exibe mensagem de erro', async () => {
    mockSyncFromTalentum.mockRejectedValueOnce(new Error('Network error'));
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);

    await act(() => Promise.resolve());

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });
});

describe('Sync button — long press 3s (force=true)', () => {
  it('segurar por 3s chama syncFromTalentum({ force: true })', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);

    // Avança 3s — timer do long press dispara
    act(() => { vi.advanceTimersByTime(3000); });

    await act(() => Promise.resolve());

    expect(mockSyncFromTalentum).toHaveBeenCalledTimes(1);
    expect(mockSyncFromTalentum).toHaveBeenCalledWith({ force: true });
  });

  it('soltar antes de 3s NÃO dispara force, dispara sync normal', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(1500); }); // metade do tempo
    fireEvent.mouseUp(btn);

    await act(() => Promise.resolve());

    expect(mockSyncFromTalentum).toHaveBeenCalledTimes(1);
    expect(mockSyncFromTalentum).toHaveBeenCalledWith(undefined); // sem force
  });

  it('após force sync completo NÃO dispara sync normal no mouseUp', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(3000); });
    await act(() => Promise.resolve());

    // mouseUp após timer já ter disparado
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    // Deve ter chamado apenas 1 vez (a do force)
    expect(mockSyncFromTalentum).toHaveBeenCalledTimes(1);
    expect(mockSyncFromTalentum).toHaveBeenCalledWith({ force: true });
  });
});

describe('Sync button — cancelamento via mouseLeave', () => {
  it('mouseLeave durante press cancela sem disparar request', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.mouseLeave(btn);

    // Avança tempo restante — timer deveria estar cancelado
    act(() => { vi.advanceTimersByTime(5000); });
    await act(() => Promise.resolve());

    expect(mockSyncFromTalentum).not.toHaveBeenCalled();
  });
});

describe('Sync button — desabilitado durante sync', () => {
  it('botão fica disabled enquanto sync está em andamento', async () => {
    // Faz a promise do sync nunca resolver imediatamente
    let resolveSync!: (v: unknown) => void;
    mockSyncFromTalentum.mockReturnValueOnce(
      new Promise((r) => { resolveSync = r; }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);

    await act(() => Promise.resolve());

    expect(btn).toBeDisabled();

    // Resolve o sync
    await act(async () => {
      resolveSync({ total: 0, updated: 0, created: 0, skipped: 0, errors: [] });
    });

    expect(btn).toBeEnabled();
  });

  it('mouseDown em botão disabled não inicia press', async () => {
    let resolveSync!: (v: unknown) => void;
    mockSyncFromTalentum.mockReturnValueOnce(
      new Promise((r) => { resolveSync = r; }),
    );

    renderPage();
    const btn = getSyncButton();

    // Primeiro sync — deixa botão disabled
    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());
    expect(btn).toBeDisabled();

    // Tenta iniciar outro press — não deve funcionar
    mockSyncFromTalentum.mockClear();
    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    expect(mockSyncFromTalentum).not.toHaveBeenCalled();

    // Limpa
    await act(async () => {
      resolveSync({ total: 0, updated: 0, created: 0, skipped: 0, errors: [] });
    });
  });
});

describe('Sync button — refetch após sync', () => {
  it('refetch é chamado após sync normal', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);

    await act(() => Promise.resolve());

    expect(mockRefetch).toHaveBeenCalled();
  });

  it('refetch é chamado após force sync', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    act(() => { vi.advanceTimersByTime(3000); });

    await act(() => Promise.resolve());

    expect(mockRefetch).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTES VISUAIS — Estrutura e animação do botão
// ═══════════════════════════════════════════════════════════════════════════

describe('Sync button — estrutura visual do fill overlay', () => {
  it('VISUAL: botão contém div de fill com classes corretas', () => {
    renderPage();
    const btn = getSyncButton();
    const fill = getFillOverlay(btn);

    expect(fill).toBeTruthy();
    expect(fill.className).toContain('absolute');
    expect(fill.className).toContain('inset-y-0');
    expect(fill.className).toContain('left-0');
    expect(fill.className).toContain('bg-primary/15');
    expect(fill.className).toContain('rounded-full');
    expect(fill.className).toContain('pointer-events-none');
  });

  it('VISUAL: fill overlay tem width 0% no estado inicial', () => {
    renderPage();
    const btn = getSyncButton();
    const fill = getFillOverlay(btn);

    expect(fill.style.width).toBe('0%');
  });

  it('VISUAL: fill overlay muda para width 100% com transição 3s ao pressionar', () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);

    const fill = getFillOverlay(btn);
    expect(fill.style.width).toBe('100%');
    expect(fill.style.transition).toContain('width 3s linear');
  });

  it('VISUAL: fill overlay volta para 0% com transição rápida ao soltar', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    const fill = getFillOverlay(btn);
    expect(fill.style.width).toBe('100%');

    fireEvent.mouseUp(btn);

    expect(fill.style.width).toBe('0%');
    expect(fill.style.transition).toContain('0.15s ease-out');

    // Flush async state updates from handleSyncTalentum
    await act(() => Promise.resolve());
  });

  it('VISUAL: fill overlay volta para 0% ao cancelar (mouseLeave)', () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    expect(getFillOverlay(btn).style.width).toBe('100%');

    fireEvent.mouseLeave(btn);

    expect(getFillOverlay(btn).style.width).toBe('0%');
  });
});

describe('Sync button — z-index e hierarquia visual', () => {
  it('VISUAL: ícone RefreshCw tem z-10 para ficar acima do fill', () => {
    renderPage();
    const btn = getSyncButton();
    const svg = btn.querySelector('svg');

    expect(svg).toBeTruthy();
    expect(svg!.classList.contains('z-10')).toBe(true);
  });

  it('VISUAL: texto do botão tem z-10 para ficar acima do fill', () => {
    renderPage();
    const textSpan = screen.getByText('admin.vacancies.syncTalentum');

    expect(textSpan.className).toContain('z-10');
  });

  it('VISUAL: botão tem classes relative e select-none', () => {
    renderPage();
    const btn = getSyncButton();

    expect(btn.className).toContain('relative');
    expect(btn.className).toContain('select-none');
  });

  it('VISUAL: botão herda overflow-hidden do componente Button', () => {
    renderPage();
    const btn = getSyncButton();

    expect(btn.className).toContain('overflow-hidden');
  });
});

describe('Sync button — estado visual durante sync', () => {
  it('VISUAL: ícone gira (animate-spin) durante sync', async () => {
    let resolveSync!: (v: unknown) => void;
    mockSyncFromTalentum.mockReturnValueOnce(
      new Promise((r) => { resolveSync = r; }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    const svg = btn.querySelector('svg');
    expect(svg!.classList.contains('animate-spin')).toBe(true);

    await act(async () => {
      resolveSync({ total: 0, updated: 0, created: 0, skipped: 0, errors: [] });
    });
  });

  it('VISUAL: texto muda para "syncing" durante sync', async () => {
    let resolveSync!: (v: unknown) => void;
    mockSyncFromTalentum.mockReturnValueOnce(
      new Promise((r) => { resolveSync = r; }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    expect(screen.getByText('admin.vacancies.syncing')).toBeInTheDocument();

    await act(async () => {
      resolveSync({ total: 0, updated: 0, created: 0, skipped: 0, errors: [] });
    });

    expect(screen.getByText('admin.vacancies.syncTalentum')).toBeInTheDocument();
  });

  it('VISUAL: mensagem de sucesso tem cor verde', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    const msg = screen.getByText('1 actualizadas');
    expect(msg.className).toContain('text-green-600');
  });

  it('VISUAL: mensagem de erro tem cor vermelha', async () => {
    mockSyncFromTalentum.mockRejectedValueOnce(new Error('Falhou'));
    renderPage();
    const btn = getSyncButton();

    fireEvent.mouseDown(btn);
    fireEvent.mouseUp(btn);
    await act(() => Promise.resolve());

    const msg = screen.getByText('Falhou');
    expect(msg.className).toContain('text-red-600');
  });
});
