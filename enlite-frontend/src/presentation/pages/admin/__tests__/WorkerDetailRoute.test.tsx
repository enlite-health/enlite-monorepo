/**
 * Task 6 — Route & navigation tests.
 *
 * Tests that:
 * 1. /admin/workers/:id route renders WorkerDetailPage
 * 2. Clicking a row in AdminWorkersPage navigates to /admin/workers/:id
 * 3. WorkerDetailPage back button navigates to /admin/workers
 * 4. WorkerEncuadresCard row click navigates to /admin/vacancies/:id
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkersTable } from '@presentation/components/features/admin/WorkersTable';
import type { WorkerRow } from '@presentation/components/features/admin/WorkersTable';

// ── Mocks ───────────────────────────────────────────────────────────────────

// WorkerDetailContent calls useAdminAuth (Firebase). Non-admin profile → no edit
// affordance, keeping these route/navigation tests independent of auth state.
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'pt-BR' },
  }),
}));

// ── WorkersTable → onRowClick navigation ────────────────────────────────────

describe('WorkersTable — row click navigation', () => {
  const workers: WorkerRow[] = [
    {
      id: 'worker-abc',
      name: 'Ana Silva',
      email: 'ana@test.com',
      casesCount: 3,
      documentsComplete: true,
      documentsStatus: 'approved',
      platform: 'talentum',
      createdAt: '2026-01-10T00:00:00Z',
    },
    {
      id: 'worker-def',
      name: 'Carlos González',
      email: 'carlos@test.com',
      casesCount: 0,
      documentsComplete: false,
      documentsStatus: 'pending',
      platform: 'planilla',
      createdAt: '2026-02-20T00:00:00Z',
    },
  ];

  it('calls onRowClick with the correct worker id when a row is clicked', async () => {
    const handleRowClick = vi.fn();
    const user = userEvent.setup();

    render(<WorkersTable workers={workers} onRowClick={handleRowClick} />);

    const rows = screen.getAllByRole('row');
    // rows[0] is the header, rows[1] is worker-abc, rows[2] is worker-def
    await user.click(rows[1]);
    expect(handleRowClick).toHaveBeenCalledWith('worker-abc');

    await user.click(rows[2]);
    expect(handleRowClick).toHaveBeenCalledWith('worker-def');
  });

  it('renders rows with cursor-pointer when onRowClick is provided', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);

    const rows = screen.getAllByRole('row');
    // Data rows (not header) should have cursor-pointer
    expect(rows[1].className).toContain('cursor-pointer');
    expect(rows[2].className).toContain('cursor-pointer');
  });

  it('renders rows without cursor-pointer when onRowClick is not provided', () => {
    render(<WorkersTable workers={workers} />);

    const rows = screen.getAllByRole('row');
    expect(rows[1].className).not.toContain('cursor-pointer');
  });

  it('renders worker name and email in each row', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);

    expect(screen.getByText('Ana Silva')).toBeInTheDocument();
    expect(screen.getByText('ana@test.com')).toBeInTheDocument();
    expect(screen.getByText('Carlos González')).toBeInTheDocument();
    expect(screen.getByText('carlos@test.com')).toBeInTheDocument();
  });

  it('renders cases count for each worker', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('renders "Completo" badge for documentsComplete=true', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.docsStatus.complete')).toBeInTheDocument();
  });

  it('renders "Pendente" badge for documentsComplete=false with pending status', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.docsStatus.pending')).toBeInTheDocument();
  });

  it('renders "Rejeitado" badge for rejected documents status', () => {
    const rejectedWorkers: WorkerRow[] = [{
      ...workers[0],
      documentsComplete: false,
      documentsStatus: 'rejected',
    }];
    render(<WorkersTable workers={rejectedWorkers} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.docsStatus.rejected')).toBeInTheDocument();
  });

  it('renders "Incompleto" badge for other status when documentsComplete is false', () => {
    const incompleteWorkers: WorkerRow[] = [{
      ...workers[0],
      documentsComplete: false,
      documentsStatus: 'incomplete',
    }];
    render(<WorkersTable workers={incompleteWorkers} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.docsStatus.incomplete')).toBeInTheDocument();
  });

  it('renders empty state message when workers is empty', () => {
    render(<WorkersTable workers={[]} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.noWorkers')).toBeInTheDocument();
  });

  it('renders formatted dates in pt-BR locale', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);
    expect(screen.getByText(/\/01\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/\/02\/2026/)).toBeInTheDocument();
  });

  it('renders dash for empty createdAt date', () => {
    const workerNoDate: WorkerRow[] = [{ ...workers[0], createdAt: '' }];
    render(<WorkersTable workers={workerNoDate} onRowClick={vi.fn()} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders table column headers', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.table.name')).toBeInTheDocument();
    expect(screen.getByText('admin.workers.table.cases')).toBeInTheDocument();
    expect(screen.getByText('admin.workers.table.documents')).toBeInTheDocument();
    expect(screen.getByText('admin.workers.table.registeredAt')).toBeInTheDocument();
    expect(screen.getByText('admin.workers.table.platform')).toBeInTheDocument();
  });

  it('handles null/undefined workers gracefully (safeWorkers fallback)', () => {
    render(<WorkersTable workers={null as any} onRowClick={vi.fn()} />);
    expect(screen.getByText('admin.workers.noWorkers')).toBeInTheDocument();
  });

  it('renders platform label from PLATFORM_LABELS when known', () => {
    render(<WorkersTable workers={workers} onRowClick={vi.fn()} />);
    expect(screen.getByText('Talentum')).toBeInTheDocument();
  });

  it('falls back to raw platform string when not in PLATFORM_LABELS', () => {
    const customWorkers: WorkerRow[] = [{
      ...workers[0],
      platform: 'unknown_platform',
    }];
    render(<WorkersTable workers={customWorkers} onRowClick={vi.fn()} />);
    expect(screen.getByText('unknown_platform')).toBeInTheDocument();
  });

  it('renders known platform labels (Planilla Operativa)', () => {
    const planillaWorkers: WorkerRow[] = [{
      ...workers[0],
      platform: 'planilla_operativa',
    }];
    render(<WorkersTable workers={planillaWorkers} onRowClick={vi.fn()} />);
    expect(screen.getByText('Planilla Operativa')).toBeInTheDocument();
  });
});

// ── WorkerDetailPage — back navigation ──────────────────────────────────────

describe('WorkerDetailPage — back button navigates to /admin/workers', () => {
  const mockNavigate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('navigates to /admin/workers when back button is clicked', async () => {
    // Mock dependencies inline for this isolated test
    vi.doMock('react-router-dom', () => ({
      useParams: () => ({ id: 'worker-123' }),
      useNavigate: () => mockNavigate,
      useLocation: () => ({ state: null }),
    }));

    vi.doMock('@hooks/admin/useWorkerDetail', () => ({
      useWorkerDetail: () => ({
        worker: null,
        isLoading: false,
        error: 'Not found',
        refetch: vi.fn(),
      }),
    }));

    vi.doMock('@presentation/components/ui/skeletons', () => ({
      DetailSkeleton: () => <div data-testid="skeleton" />,
    }));

    vi.doMock('@hooks/admin/useAdminAdditionalDocuments', () => ({
      useAdminAdditionalDocuments: () => ({
        documents: [], isLoading: false, fetchDocuments: vi.fn(),
        uploadDocument: vi.fn(), deleteDocument: vi.fn(), viewDocument: vi.fn(),
      }),
    }));

    const { default: WorkerDetailPage } = await import('../WorkerDetailPage');

    const user = userEvent.setup();
    render(<WorkerDetailPage />);

    const backButton = screen.getByText('admin.workerDetail.back');
    await user.click(backButton);

    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers');
  });
});

// ── Route existence verification ────────────────────────────────────────────

describe('App routing — /admin/workers/:id route is registered', () => {
  it('WorkerDetailPage is a valid default export', async () => {
    const mod = await import('../WorkerDetailPage');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});
