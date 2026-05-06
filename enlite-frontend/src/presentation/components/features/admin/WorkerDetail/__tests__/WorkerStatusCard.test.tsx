import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkerStatusCard } from '../WorkerStatusCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const baseProps = {
  status: 'REGISTERED' as const,
  dataSources: ['talentum'],
  platform: 'talentum',
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',
};

describe('WorkerStatusCard', () => {
  // ── i18n labels ────────────────────────────────────────────────────────────

  it('renders the card title using i18n key admin.workerDetail.status', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.status')).toBeInTheDocument();
  });

  it('renders platform label using i18n key admin.workerDetail.platform', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.platform')).toBeInTheDocument();
  });

  it('renders dataSources label using i18n key admin.workerDetail.dataSources', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.dataSources')).toBeInTheDocument();
  });

  it('renders createdAt label using i18n key admin.workerDetail.createdAt', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.createdAt')).toBeInTheDocument();
  });

  it('renders updatedAt label using i18n key admin.workerDetail.updatedAt', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.updatedAt')).toBeInTheDocument();
  });

  // ── Status badge ───────────────────────────────────────────────────────────

  it('renders statusLabel using i18n key admin.workerDetail.statusLabel', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.statusLabel')).toBeInTheDocument();
  });

  it('renders the status badge with translated label', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText('admin.workerDetail.statusRegistered')).toBeInTheDocument();
  });

  it('applies green color for REGISTERED status', () => {
    render(<WorkerStatusCard {...baseProps} />);
    const badge = screen.getByText('admin.workerDetail.statusRegistered').parentElement!;
    expect(badge.className).toContain('bg-green-100');
    expect(badge.className).toContain('text-green-700');
  });

  it('applies yellow color for INCOMPLETE_REGISTER status', () => {
    render(<WorkerStatusCard {...baseProps} status="INCOMPLETE_REGISTER" />);
    const badge = screen.getByText('admin.workerDetail.statusIncomplete').parentElement!;
    expect(badge.className).toContain('bg-yellow-100');
    expect(badge.className).toContain('text-yellow-700');
  });

  it('applies red color for DISABLED status', () => {
    render(<WorkerStatusCard {...baseProps} status="DISABLED" />);
    const badge = screen.getByText('admin.workerDetail.statusDisabled').parentElement!;
    expect(badge.className).toContain('bg-red-100');
    expect(badge.className).toContain('text-red-700');
  });

  it('applies gray fallback color for unknown status', () => {
    render(<WorkerStatusCard {...baseProps} status={'UNKNOWN' as any} />);
    const badge = screen.getByText('UNKNOWN').parentElement!;
    expect(badge.className).toContain('bg-gray-100');
    expect(badge.className).toContain('text-gray-600');
  });

  // ── Data display ───────────────────────────────────────────────────────────

  it('renders platform value using getPlatformLabel', () => {
    render(<WorkerStatusCard {...baseProps} />);
    // getPlatformLabel calls t() which returns the i18n key
    expect(screen.getAllByText('admin.workers.platformOptions.talentum').length).toBeGreaterThanOrEqual(1);
  });

  it('renders data sources joined by comma using getPlatformLabel', () => {
    render(<WorkerStatusCard {...baseProps} dataSources={['talentum', 'planilla']} />);
    // 'talentum' → i18n key; 'planilla' has no mapping → stays 'planilla'
    expect(screen.getByText('admin.workers.platformOptions.talentum, planilla')).toBeInTheDocument();
  });

  it('hides data sources row when array is empty', () => {
    render(<WorkerStatusCard {...baseProps} dataSources={[]} />);
    expect(screen.queryByText('admin.workerDetail.dataSources')).not.toBeInTheDocument();
  });

  it('renders formatted dates in pt-BR locale', () => {
    render(<WorkerStatusCard {...baseProps} />);
    expect(screen.getByText(/\/01\/2026/)).toBeInTheDocument();
    expect(screen.getByText(/\/03\/2026/)).toBeInTheDocument();
  });
});
