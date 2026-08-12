import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MatchBucketSection } from '../MatchBucketSection';
import type { DistanceBucket } from '../matchModalHelpers';
import type { SavedCandidate } from '../../../../../../types/match';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'admin.match.selectAllInGroup') return `Seleccionar todos (${opts?.group})`;
      if (key === 'admin.match.candidatesCount') return `${opts?.count} candidatos`;
      return key;
    },
    i18n: { language: 'es' },
  }),
}));

function makeCandidate(id: string, over: Partial<SavedCandidate> = {}): SavedCandidate {
  return {
    workerId: id,
    workerName: `Worker ${id}`,
    workerPhone: '+5411000',
    occupation: 'AT',
    workZone: 'Z',
    distanceKm: 3,
    activeCasesCount: 0,
    overallStatus: null,
    documentStatus: null,
    matchScore: 10,
    internalNotes: null,
    alreadyApplied: false,
    messagedAt: null,
    ...over,
  };
}

const bucket: DistanceBucket = {
  label: '≤ 5 km',
  candidates: [makeCandidate('a'), makeCandidate('b'), makeCandidate('c')],
};

function renderSection(
  selectedIds: Set<string>,
  onToggleSelectAll = vi.fn(),
) {
  render(
    <MemoryRouter>
      <MatchBucketSection
        bucket={bucket}
        selectedIds={selectedIds}
        onToggleSelect={() => {}}
        onToggleSelectAll={onToggleSelectAll}
        onInviteOne={() => {}}
      />
    </MemoryRouter>,
  );
  return onToggleSelectAll;
}

describe('MatchBucketSection — select-all per Km group (AC1 86ajb48v1)', () => {
  it('renders a select-all checkbox in the group header', () => {
    renderSection(new Set());
    expect(
      screen.getByRole('checkbox', { name: 'Seleccionar todos (≤ 5 km)' }),
    ).toBeInTheDocument();
  });

  it('is unchecked and not indeterminate when nothing is selected', () => {
    renderSection(new Set());
    const cb = screen.getByRole('checkbox', {
      name: 'Seleccionar todos (≤ 5 km)',
    }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(cb.indeterminate).toBe(false);
  });

  it('is indeterminate when only some candidates are selected', () => {
    renderSection(new Set(['a']));
    const cb = screen.getByRole('checkbox', {
      name: 'Seleccionar todos (≤ 5 km)',
    }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(cb.indeterminate).toBe(true);
  });

  it('is checked when all candidates are selected', () => {
    renderSection(new Set(['a', 'b', 'c']));
    const cb = screen.getByRole('checkbox', {
      name: 'Seleccionar todos (≤ 5 km)',
    }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.indeterminate).toBe(false);
  });

  it('clicking select-all when empty selection requests select=true for every candidate', () => {
    const spy = renderSection(new Set());
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar todos (≤ 5 km)' }),
    );
    expect(spy).toHaveBeenCalledWith(bucket.candidates, true);
  });

  it('clicking select-all when all selected requests select=false (deselect)', () => {
    const spy = renderSection(new Set(['a', 'b', 'c']));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Seleccionar todos (≤ 5 km)' }),
    );
    expect(spy).toHaveBeenCalledWith(bucket.candidates, false);
  });

  it('does not render the select-all checkbox for an empty bucket', () => {
    render(
      <MemoryRouter>
        <MatchBucketSection
          bucket={{ label: '≤ 5 km', candidates: [] }}
          selectedIds={new Set()}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          onInviteOne={() => {}}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
