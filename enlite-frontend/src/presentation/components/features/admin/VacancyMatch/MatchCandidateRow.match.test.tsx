import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MatchCandidateRow } from './MatchCandidateRow.match';
import type { SavedCandidate } from '../../../../../types/match';

vi.mock('@presentation/components/atoms/WorkerAvatar', () => ({
  WorkerAvatar: ({ name }: { name: string | null }) => (
    <div data-testid="worker-avatar">{name}</div>
  ),
}));

const candidate: SavedCandidate = {
  workerId: 'w-9',
  workerName: 'Maria García',
  workerPhone: '+54 9 11 9999-0000',
  occupation: 'AT',
  workZone: 'Caballito',
  distanceKm: 1.5,
  activeCasesCount: 0,
  overallStatus: 'TALENTUM',
  matchScore: 70,
  internalNotes: null,
  alreadyApplied: false,
  messagedAt: null,
  documentStatus: null,
};

describe('MatchCandidateRow.match — worker profile link (modal)', () => {
  it('renders the name as a link to the worker detail opening in a new tab', () => {
    render(
      <MatchCandidateRow
        candidate={candidate}
        selected={false}
        onToggleSelect={vi.fn()}
        onInviteOne={vi.fn()}
      />,
    );

    const link = screen.getByTestId('match-modal-worker-link');
    expect(link).toHaveAttribute('href', '/admin/workers/w-9');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link).toHaveTextContent('Maria García');
  });
});
