import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TimeRangeFilter } from './TimeRangeFilter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

function renderFilter(props: Partial<Parameters<typeof TimeRangeFilter>[0]> = {}) {
  const fallbackFrom = vi.fn();
  const fallbackTo = vi.fn();
  const mergedProps = {
    from: '',
    to: '',
    onFromChange: fallbackFrom,
    onToChange: fallbackTo,
    ...props,
  };
  const result = render(<TimeRangeFilter {...mergedProps} />);
  return { ...result, onFromChange: mergedProps.onFromChange, onToChange: mergedProps.onToChange };
}

/** Abre o combobox (botão) e devolve a lista. */
function openList(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
  return screen.getByRole('listbox');
}

describe('TimeRangeFilter — combobox com busca (REQ-06)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the time label', () => {
    renderFilter();
    expect(screen.getByText('admin.vacancies.filters.time.label')).toBeInTheDocument();
  });

  it('renders two comboboxes (from and to) with their placeholders', () => {
    renderFilter();
    expect(screen.getByTestId('time-from')).toHaveTextContent('admin.vacancies.filters.time.from');
    expect(screen.getByTestId('time-to')).toHaveTextContent('admin.vacancies.filters.time.to');
  });

  it('lists 48 times from 00:00 to 23:30 in 30-minute steps (+ the "all" entry)', () => {
    renderFilter();
    const list = openList('time-from');
    const options = within(list).getAllByRole('option');
    // 1ª entrada é o "todos"/placeholder; depois 48 horários
    expect(options).toHaveLength(49);
    expect(options[1]).toHaveTextContent('00:00');
    expect(options[options.length - 1]).toHaveTextContent('23:30');
  });

  it('typing filters the times ("14" → 14:00 and 14:30)', () => {
    renderFilter();
    const list = openList('time-from');
    fireEvent.change(screen.getByPlaceholderText('Buscar...'), { target: { value: '14' } });
    const labels = within(list).getAllByRole('option').map((o) => o.textContent);
    expect(labels).toEqual(['admin.vacancies.filters.time.from', '14:00', '14:30']);
  });

  it('calls onFromChange when a time is picked in "from"', () => {
    const { onFromChange } = renderFilter();
    const list = openList('time-from');
    fireEvent.click(within(list).getByText('09:00'));
    expect(onFromChange).toHaveBeenCalledWith('09:00');
  });

  it('calls onToChange when a time is picked in "to"', () => {
    const { onToChange } = renderFilter();
    const list = openList('time-to');
    fireEvent.click(within(list).getByText('17:30'));
    expect(onToChange).toHaveBeenCalledWith('17:30');
  });

  it('shows the selected values on the buttons', () => {
    renderFilter({ from: '09:00', to: '17:00' });
    expect(screen.getByTestId('time-from')).toHaveTextContent('09:00');
    expect(screen.getByTestId('time-to')).toHaveTextContent('17:00');
  });
});
