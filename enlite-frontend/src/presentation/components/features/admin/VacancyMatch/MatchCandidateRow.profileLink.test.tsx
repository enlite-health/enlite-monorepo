import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MatchCandidateRow } from './MatchCandidateRow';
import type { SavedCandidate } from '../../../../../types/match';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'es-AR' } }),
}));

const candidate: SavedCandidate = {
  workerId: 'w-1',
  workerName: 'Juan Pérez',
  workerPhone: '+54 9 11 1234-5678',
  occupation: 'AT',
  workZone: 'Palermo',
  distanceKm: 3.2,
  activeCasesCount: 0,
  overallStatus: 'QUALIFICADO',
  matchScore: 87,
  internalNotes: null,
  alreadyApplied: false,
  messagedAt: null,
};

function renderRow(c: SavedCandidate, initialPath = '/admin/vacancies/vac-123/match') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <table>
        <tbody>
          <MatchCandidateRow
            candidate={c}
            rank={1}
            isSelected={false}
            onToggleSelect={vi.fn()}
            onSendMessage={vi.fn()}
          />
        </tbody>
      </table>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockNavigate.mockReset();
});

describe('MatchCandidateRow — worker profile link', () => {
  it('navigates to the worker detail with the origin path in state when clicking the name', () => {
    renderRow(candidate, '/admin/vacancies/vac-123/match');
    fireEvent.click(screen.getByTestId('match-worker-link'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers/w-1', {
      state: { from: '/admin/vacancies/vac-123/match' },
    });
  });

  it('renders the worker name inside the link', () => {
    renderRow(candidate);
    expect(screen.getByTestId('match-worker-link')).toHaveTextContent('Juan Pérez');
  });

  it('does not navigate when the candidate has no workerId', () => {
    renderRow({ ...candidate, workerId: '' });
    fireEvent.click(screen.getByTestId('match-worker-link'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
