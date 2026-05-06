import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkerEncuadresCard } from '../WorkerEncuadresCard';
import type { WorkerEncuadre } from '@domain/entities/Worker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => opts?.defaultValue ?? key,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const encuadres: WorkerEncuadre[] = [
  {
    id: 'enc-1',
    jobPostingId: 'jp-100',
    caseNumber: 442,
    patientName: 'Juan Pérez',
    resultado: 'SELECCIONADO',
    interviewDate: '2026-03-10',
    interviewTime: '10:00',
    recruiterName: 'Maria',
    coordinatorName: 'Carlos',
    rejectionReason: null,
    rejectionReasonCategory: null,
    attended: true,
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'enc-2',
    jobPostingId: null,
    caseNumber: null,
    patientName: null,
    resultado: 'RECHAZADO',
    interviewDate: null,
    interviewTime: null,
    recruiterName: null,
    coordinatorName: null,
    rejectionReason: 'Distancia',
    rejectionReasonCategory: 'DISTANCE',
    attended: false,
    createdAt: '2026-02-15T00:00:00Z',
  },
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

  it('renders result column header using i18n key admin.workerDetail.result', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText('admin.workerDetail.result')).toBeInTheDocument();
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
    expect(screen.getByText('SELECCIONADO')).toBeInTheDocument();
    expect(screen.getByText('Maria')).toBeInTheDocument();
  });

  it('renders dash for null fields', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    const dashes = screen.getAllByText('—');
    // enc-2: caseNumber, patientName, interview, recruiter = 4 dashes
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  // ── Interview display ──────────────────────────────────────────────────────

  it('renders interview date and time when both present', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getByText(/3\/2026.*10:00/)).toBeInTheDocument();
  });

  it('renders interview date without time when interviewTime is null', () => {
    const withDateOnly: WorkerEncuadre[] = [{
      ...encuadres[0],
      interviewTime: null,
    }];
    render(<WorkerEncuadresCard encuadres={withDateOnly} />);
    // When interviewTime is null, the time portion must not be rendered
    expect(screen.queryByText(/10:00/)).not.toBeInTheDocument();
    // At least one formatted date cell is visible
    expect(screen.getAllByText(/3\/2026/).length).toBeGreaterThan(0);
  });

  it('renders dash when interviewDate is null', () => {
    render(<WorkerEncuadresCard encuadres={[encuadres[1]]} />);
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  // ── Resultado badges ───────────────────────────────────────────────────────

  it('applies green badge for SELECCIONADO', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    const badge = screen.getByText('SELECCIONADO').parentElement!;
    expect(badge.className).toContain('bg-green-100');
    expect(badge.className).toContain('text-green-700');
  });

  it('applies red badge for RECHAZADO', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    const badge = screen.getByText('RECHAZADO').parentElement!;
    expect(badge.className).toContain('bg-red-100');
    expect(badge.className).toContain('text-red-700');
  });

  it('applies yellow badge for PENDIENTE', () => {
    const pending: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'PENDIENTE' }];
    render(<WorkerEncuadresCard encuadres={pending} />);
    const badge = screen.getByText('PENDIENTE').parentElement!;
    expect(badge.className).toContain('bg-yellow-100');
  });

  it('applies orange badge for AT_NO_ACEPTA', () => {
    const noAcepta: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'AT_NO_ACEPTA' }];
    render(<WorkerEncuadresCard encuadres={noAcepta} />);
    const badge = screen.getByText('AT_NO_ACEPTA').parentElement!;
    expect(badge.className).toContain('bg-orange-100');
  });

  it('applies blue badge for REPROGRAMAR', () => {
    const reprog: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'REPROGRAMAR' }];
    render(<WorkerEncuadresCard encuadres={reprog} />);
    const badge = screen.getByText('REPROGRAMAR').parentElement!;
    expect(badge.className).toContain('bg-blue-100');
  });

  it('applies purple badge for REEMPLAZO', () => {
    const reem: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'REEMPLAZO' }];
    render(<WorkerEncuadresCard encuadres={reem} />);
    const badge = screen.getByText('REEMPLAZO').parentElement!;
    expect(badge.className).toContain('bg-purple-100');
  });

  it('applies black badge for BLACKLIST', () => {
    const bl: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'BLACKLIST' }];
    render(<WorkerEncuadresCard encuadres={bl} />);
    const badge = screen.getByText('BLACKLIST').parentElement!;
    expect(badge.className).toContain('bg-gray-800');
    expect(badge.className).toContain('text-white');
  });

  it('applies gray fallback badge for unknown resultado', () => {
    const unknown: WorkerEncuadre[] = [{ ...encuadres[0], resultado: 'CUSTOM_STATUS' }];
    render(<WorkerEncuadresCard encuadres={unknown} />);
    const badge = screen.getByText('CUSTOM_STATUS').parentElement!;
    expect(badge.className).toContain('bg-gray-100');
  });

  it('renders dash badge when resultado is null', () => {
    const nullRes: WorkerEncuadre[] = [{ ...encuadres[0], resultado: null }];
    render(<WorkerEncuadresCard encuadres={nullRes} />);
    // The badge area should show '—'
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
    // Data rows (not header) should have cursor-pointer
    expect(rows[1].className).toContain('cursor-pointer');
  });

  // ── Dates ──────────────────────────────────────────────────────────────────

  it('renders created dates formatted in es-AR locale', () => {
    render(<WorkerEncuadresCard encuadres={encuadres} />);
    expect(screen.getAllByText(/3\/2026/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/2\/2026/).length).toBeGreaterThanOrEqual(1);
  });
});
