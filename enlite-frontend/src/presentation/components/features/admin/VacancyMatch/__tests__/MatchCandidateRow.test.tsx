import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MatchCandidateRow } from '../MatchCandidateRow';
import { Table, TableBody } from '@presentation/components/atoms/Table';
import type { SavedCandidate } from '../../../../../../types/match';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'pt-BR' },
  }),
}));

function makeCandidate(overrides: Partial<SavedCandidate> = {}): SavedCandidate {
  return {
    workerId: 'w-1',
    workerName: 'Maria Silva',
    workerPhone: '+5511999999999',
    occupation: 'AT',
    workZone: 'Zona Sul',
    distanceKm: 3.2,
    activeCasesCount: 0,
    overallStatus: 'QUALIFICADO',
    documentStatus: 'approved',
    matchScore: 87,
    internalNotes: null,
    alreadyApplied: false,
    messagedAt: null,
    ...overrides,
  };
}

function renderRow(candidate: SavedCandidate) {
  return render(
    <Table>
      <TableBody>
        <MatchCandidateRow
          candidate={candidate}
          rank={1}
          isSelected={false}
          onToggleSelect={() => {}}
          onSendMessage={() => {}}
        />
      </TableBody>
    </Table>,
  );
}

describe('MatchCandidateRow — document status column', () => {
  it('renders the DocsStatusBadge with the approved (green) label', () => {
    renderRow(makeCandidate({ documentStatus: 'approved' }));
    const label = screen.getByText('admin.workers.docsStatus.approved');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-green-100');
  });

  it('renders a red badge for a pending document status', () => {
    renderRow(makeCandidate({ documentStatus: 'pending' }));
    const label = screen.getByText('admin.workers.docsStatus.pending');
    expect(label.closest('span')?.parentElement?.className).toContain('bg-red-100');
  });

  it('renders an em dash when documentStatus is null', () => {
    renderRow(makeCandidate({ documentStatus: null }));
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
