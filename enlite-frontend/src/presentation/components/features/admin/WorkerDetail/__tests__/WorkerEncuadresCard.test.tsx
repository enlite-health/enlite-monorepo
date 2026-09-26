import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerEncuadresCard } from '../WorkerEncuadresCard';
import type { WorkerEncuadre } from '@domain/entities/Worker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Kanban column labels resolve via defaultValue = the raw stage; headers fall back to key.
    t: (key: string, opts?: any) => opts?.defaultValue ?? key,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

function makeEncuadre(overrides: Partial<WorkerEncuadre> = {}): WorkerEncuadre {
  return {
    id: 'enc-1',
    jobPostingId: 'jp-100',
    caseNumber: 442,
    vacancyNumber: 1,
    patientName: 'Juan Pérez',
    kanbanStage: 'SELECTED',
    vacancyStatus: 'ACTIVE',
    resultado: 'SELECCIONADO',
    interviewDate: '2026-03-10',
    interviewTime: '10:00',
    recruiterName: 'Maria',
    coordinatorName: 'Carlos',
    rejectionReason: null,
    rejectionReasonCategory: null,
    attended: true,
    isBlocked: false,
    blockedReason: null,
    missingFields: [],
    attemptCount: null,
    createdAt: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

const encuadres: WorkerEncuadre[] = [
  makeEncuadre(),
  makeEncuadre({
    id: 'enc-2',
    jobPostingId: null,
    caseNumber: null,
    vacancyNumber: null,
    patientName: null,
    kanbanStage: 'REJECTED',
    resultado: 'RECHAZADO',
    interviewDate: null,
    interviewTime: null,
    recruiterName: null,
    coordinatorName: null,
    rejectionReason: 'Distancia',
    rejectionReasonCategory: 'DISTANCE',
    attended: false,
    createdAt: '2026-02-15T00:00:00Z',
  }),
];

describe('WorkerEncuadresCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── i18n labels ────────────────────────────────────────────────────────────

  it('renders card title using i18n key admin.workerDetail.encuadres with count', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.encuadres (2)')).toBeInTheDocument();
  });

  it('renders case column header using i18n key admin.workerDetail.case', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.case')).toBeInTheDocument();
  });

  it('renders patient column header using i18n key admin.workerDetail.patient', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.patient')).toBeInTheDocument();
  });

  it('renders status column header using i18n key admin.workerDetail.funnelStatus', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.funnelStatus')).toBeInTheDocument();
  });

  it('renders interview column header using i18n key admin.workerDetail.interview', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.interview')).toBeInTheDocument();
  });

  it('renders recruiter column header using i18n key admin.workerDetail.recruiter', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.recruiter')).toBeInTheDocument();
  });

  it('renders date column header using i18n key admin.workerDetail.date', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.date')).toBeInTheDocument();
  });

  it('renders noEncuadres message using i18n key admin.workerDetail.noEncuadres', () => {
    render(<WorkerEncuadresCard encuadres={[]} />);
    expect(screen.getByText('admin.workerDetail.noEncuadres')).toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('shows empty state and count (0) when encuadres is empty', () => {
    render(<WorkerEncuadresCard encuadres={[]} />);
    expect(screen.getByText('admin.workerDetail.encuadres (0)')).toBeInTheDocument();
    expect(screen.getByText('admin.workerDetail.noEncuadres')).toBeInTheDocument();
  });

  it('does not render table when encuadres is empty', () => {
    render(<WorkerEncuadresCard encuadres={[]} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  // ── Data rows ──────────────────────────────────────────────────────────────

  it('renders encuadre data fields', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('442')).toBeInTheDocument();
    expect(screen.getByText('Juan Pérez')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
  });

  // ── Status column = Kanban column (the core of this feature) ─────────────────

  it('renders the Kanban stage as the status, not the encuadre resultado', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    // status column shows the kanban column key (via defaultValue = raw stage)
    expect(screen.getByText('SELECTED')).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    // the old resultado value must NOT be what drives the badge anymore
    expect(screen.queryByText('SELECCIONADO')).not.toBeInTheDocument();
  });

  it('applies green badge for the SELECTED stage', () => {
    render(<WorkerEncuadresCard encuadres={[makeEncuadre({ kanbanStage: 'SELECTED' })]} />);
    const badge = screen.getByText('SELECTED').parentElement!;
    expect(badge.className).toContain('bg-green-100');
    expect(badge.className).toContain('text-green-700');
  });

  it('applies red badge for a blocked attempt (REJECTED, D433)', () => {
    render(<WorkerEncuadresCard encuadres={[makeEncuadre({ kanbanStage: 'REJECTED', isBlocked: true })]} />);
    const badge = screen.getByText('REJECTED').parentElement!;
    expect(badge.className).toContain('bg-red-100');
  });

  it('applies indigo badge for the INICIADO stage', () => {
    render(<WorkerEncuadresCard encuadres={[makeEncuadre({ kanbanStage: 'INICIADO' })]} />);
    const badge = screen.getByText('INICIADO').parentElement!;
    expect(badge.className).toContain('bg-indigo-100');
  });

  // ── Blocked attempts are surfaced (the reality gap this feature fixes) ───────

  it('renders a blocked attempt row with its BLOQUEADO status and attempt count', () => {
    const blocked = makeEncuadre({
      id: 'blk-1',
      jobPostingId: 'jp-777',
      caseNumber: 501,
      kanbanStage: 'REJECTED',
      resultado: null,
      isBlocked: true,
      blockedReason: 'registration_incomplete',
      missingFields: ['worker_documents'],
      attemptCount: 3,
    });
    render(<WorkerEncuadresCard encuadres={[blocked]} />);
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    expect(screen.getByText('501')).toBeInTheDocument();
    // attempt count is shown next to the badge (defaultValue fallback in the mock)
    expect(screen.getByText('3 intento(s)')).toBeInTheDocument();
  });

  // ── Interview display ──────────────────────────────────────────────────────

  it('renders interview date and time when both present', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText(/3\/2026.*10:00/)).toBeInTheDocument();
  });

  it('renders interview date without time when interviewTime is null', () => {
    render(<WorkerEncuadresCard encuadres={[makeEncuadre({ interviewTime: null })]} />);
    expect(screen.queryByText(/10:00/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/3\/2026/).length).toBeGreaterThan(0);
  });

  it('renders dash when interviewDate is null', () => {
    render(<WorkerEncuadresCard encuadres={[encuadres[1]]} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  // ── Navigation ─────────────────────────────────────────────────────────────

  it('navigates to vacancy when row with jobPostingId is clicked', async () => {
    const user = userEvent.setup();
    render(<WorkerEncuadresCard encuadres={encuadres} />);

    const rows = screen.getAllByRole('row');
    // rows[0] = header, rows[1] = enc-1, rows[2] = enc-2
    await user.click(rows[1]);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/vacancies/jp-100');
  });

  it('does not navigate when row has no jobPostingId', async () => {
    const user = userEvent.setup();
    render(<WorkerEncuadresCard encuadres={encuadres} />);

    const rows = screen.getAllByRole('row');
    await user.click(rows[2]); // enc-2 has null jobPostingId
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders rows with cursor-pointer class', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    const rows = screen.getAllByRole('row');
    expect(rows[1].className).toContain('cursor-pointer');
  });

  // ── Dates ──────────────────────────────────────────────────────────────────

  it('renders created dates formatted in es-AR locale', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getAllByText(/3\/2026/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/2\/2026/).length).toBeGreaterThanOrEqual(1);
  });
});
