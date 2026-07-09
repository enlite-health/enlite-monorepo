import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MatchTotalsMarker } from '../MatchTotalsMarker';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'admin.match.totals.available') return 'Disponibles';
      if (key === 'admin.match.totals.recruited') return 'Reclutados';
      return key;
    },
    i18n: { language: 'es' },
  }),
}));

describe('MatchTotalsMarker — total available vs recruited (AC3 86ajb48v1)', () => {
  it('shows the total available across all radii and the recruited count', () => {
    render(<MatchTotalsMarker availableCount={42} recruitedCount={7} />);
    const marker = screen.getByTestId('match-totals-marker');
    expect(within(marker).getByText('Disponibles')).toBeInTheDocument();
    expect(within(marker).getByText('42')).toBeInTheDocument();
    expect(within(marker).getByText('Reclutados')).toBeInTheDocument();
    expect(within(marker).getByText('7')).toBeInTheDocument();
  });

  it('renders zero counts without crashing', () => {
    render(<MatchTotalsMarker availableCount={0} recruitedCount={0} />);
    const marker = screen.getByTestId('match-totals-marker');
    expect(within(marker).getAllByText('0')).toHaveLength(2);
  });
});
