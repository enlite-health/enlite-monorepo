/**
 * AdminWorkersSyncButton.test.tsx
 *
 * Testes UNITÁRIOS (comportamento) e VISUAIS (estrutura) do botão
 * "Sincronizar Talentum" na página de Prestadores.
 *
 * Comportamento:
 *   - Clique chama syncTalentumWorkers()
 *   - Exibe mensagem de sucesso com contadores
 *   - Exibe mensagem de erro quando falha
 *   - Botão desabilitado durante sync
 *   - Chama refetch após sync
 *
 * Visual:
 *   - Botão tem ícone RefreshCw
 *   - Ícone roda (animate-spin) durante sync
 *   - Texto muda para "Sincronizando..." durante sync
 *   - Mensagem de resultado aparece ao lado do botão
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminWorkersPage } from '../AdminWorkersPage';

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockSyncTalentumWorkers = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    syncTalentumWorkers: (...args: unknown[]) => mockSyncTalentumWorkers(...args),
    listWorkers: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getWorkerDateStats: vi.fn().mockResolvedValue({ today: 0, yesterday: 0, sevenDaysAgo: 0 }),
    listWorkerTags: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@hooks/admin/useWorkersData', () => ({
  useWorkersData: () => ({
    workers: [
      { id: '1', name: 'María González', email: 'maria@test.com', casesCount: 2,
        documentsComplete: true, documentsStatus: 'complete', platform: 'Talentum',
        createdAt: '2025-01-15' },
    ],
    total: 1,
    stats: { today: 1, yesterday: 0, sevenDaysAgo: 3 },
    isLoading: false,
    error: null,
    refetch: mockRefetch,
  }),
}));

vi.mock('@hooks/admin/useCaseOptions', () => ({
  useCaseOptions: () => ({
    options: [],
    isLoading: false,
  }),
}));

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({
    adminProfile: { role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminWorkersPage />
    </MemoryRouter>,
  );
}

function getSyncButton(): HTMLElement {
  // The button text contains both an SVG icon and the i18n text.
  // Use getByRole with a regex that matches either the i18n key or fallback.
  const buttons = screen.getAllByRole('button');
  const syncBtn = buttons.find((btn) =>
    btn.textContent?.includes('admin.workers.syncTalentum') ||
    btn.textContent?.includes('Sincronizar Talentum'),
  );
  if (!syncBtn) throw new Error('Sync button not found in DOM');
  return syncBtn;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  mockSyncTalentumWorkers.mockResolvedValue({
    total: 100, created: 5, updated: 10, skipped: 83, linked: 8, errors: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTES UNITÁRIOS — Comportamento
// ═══════════════════════════════════════════════════════════════════════════

describe('Sync button — clique', () => {
  it('clique chama syncTalentumWorkers()', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    await act(() => Promise.resolve());

    expect(mockSyncTalentumWorkers).toHaveBeenCalledTimes(1);
  });

  it('após sync bem-sucedido exibe mensagem com contadores', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    await act(() => Promise.resolve());

    expect(screen.getByText(/5 creados/)).toBeInTheDocument();
    expect(screen.getByText(/10 actualizados/)).toBeInTheDocument();
    expect(screen.getByText(/8 vinculados a casos/)).toBeInTheDocument();
  });

  it('após sync com erros exibe contagem de erros', async () => {
    mockSyncTalentumWorkers.mockResolvedValueOnce({
      total: 50, created: 3, updated: 2, skipped: 43, linked: 1,
      errors: [
        { profileId: 'p1', name: 'Error Worker', error: 'DB timeout' },
        { profileId: 'p2', name: 'Other Worker', error: 'Connection lost' },
      ],
    });

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    await act(() => Promise.resolve());

    expect(screen.getByText(/2 errores/)).toBeInTheDocument();
  });

  it('após sync rejeitado exibe mensagem de erro', async () => {
    mockSyncTalentumWorkers.mockRejectedValueOnce(new Error('Network error'));

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    await act(() => Promise.resolve());

    expect(screen.getByText('Network error')).toBeInTheDocument();
  });

  it('chama refetch após sync bem-sucedido', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    await act(() => Promise.resolve());

    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('mensagem desaparece após 10 segundos', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);
    await act(() => Promise.resolve());

    expect(screen.getByText(/5 creados/)).toBeInTheDocument();

    // Avança 10s
    act(() => { vi.advanceTimersByTime(10000); });

    expect(screen.queryByText(/5 creados/)).not.toBeInTheDocument();
  });
});

describe('Sync button — estado durante sync', () => {
  it('botão fica desabilitado durante sync', async () => {
    // Make the sync take a while
    let resolveSync: () => void;
    mockSyncTalentumWorkers.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolveSync = () => resolve({
          total: 1, created: 1, updated: 0, skipped: 0, linked: 0, errors: [],
        });
      }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);

    // During sync, button should be disabled
    await act(() => Promise.resolve());
    expect(btn).toBeDisabled();

    // Resolve the sync
    await act(() => { resolveSync!(); return Promise.resolve(); });

    // After sync, button should be enabled again
    expect(btn).not.toBeDisabled();
  });

  it('texto muda para "Sincronizando..." durante sync', async () => {
    let resolveSync: () => void;
    mockSyncTalentumWorkers.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolveSync = () => resolve({
          total: 0, created: 0, updated: 0, skipped: 0, linked: 0, errors: [],
        });
      }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);
    await act(() => Promise.resolve());

    // During sync — text changes
    expect(
      btn.textContent?.includes('admin.workers.syncing') ||
      btn.textContent?.includes('Sincronizando'),
    ).toBe(true);

    // After sync
    await act(() => { resolveSync!(); return Promise.resolve(); });
    expect(
      btn.textContent?.includes('admin.workers.syncTalentum') ||
      btn.textContent?.includes('Sincronizar'),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTES VISUAIS — Estrutura do DOM
// ═══════════════════════════════════════════════════════════════════════════

describe('Sync button — estrutura visual', () => {
  it('VISUAL: botão contém ícone RefreshCw (svg)', () => {
    renderPage();
    const btn = getSyncButton();
    const svg = btn.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('VISUAL: ícone tem animate-spin durante sync', async () => {
    let resolveSync: () => void;
    mockSyncTalentumWorkers.mockReturnValueOnce(
      new Promise<any>((resolve) => {
        resolveSync = () => resolve({
          total: 0, created: 0, updated: 0, skipped: 0, linked: 0, errors: [],
        });
      }),
    );

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);
    await act(() => Promise.resolve());

    const svg = btn.querySelector('svg');
    expect(svg?.className.baseVal || svg?.getAttribute('class') || '').toContain('animate-spin');

    await act(() => { resolveSync!(); return Promise.resolve(); });
  });

  it('VISUAL: botão tem classes border-primary text-primary', () => {
    renderPage();
    const btn = getSyncButton();
    expect(btn.className).toContain('border-primary');
    expect(btn.className).toContain('text-primary');
  });

  it('VISUAL: mensagem de sucesso tem cor verde', async () => {
    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);
    await act(() => Promise.resolve());

    const message = screen.getByText(/5 creados/);
    expect(message.className).toContain('text-green-600');
  });

  it('VISUAL: mensagem de erro tem cor vermelha', async () => {
    mockSyncTalentumWorkers.mockResolvedValueOnce({
      total: 10, created: 0, updated: 0, skipped: 8, linked: 0,
      errors: [{ profileId: 'p1', name: 'X', error: 'fail' }],
    });

    renderPage();
    const btn = getSyncButton();

    fireEvent.click(btn);
    await act(() => Promise.resolve());

    const message = screen.getByText(/1 errores/);
    expect(message.className).toContain('text-red-600');
  });

  it('VISUAL: seção header tem botão ao lado do título', () => {
    renderPage();
    const btn = getSyncButton();
    // Button should be within the section header div
    const headerDiv = btn.closest('.justify-between');
    expect(headerDiv).toBeTruthy();
  });
});
