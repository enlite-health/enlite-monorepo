import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeRangeFilter } from './TimeRangeFilter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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

describe('TimeRangeFilter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the time label', () => {
    renderFilter();
    expect(screen.getByText('admin.vacancies.filters.time.label')).toBeInTheDocument();
  });

  it('renders two select elements (from and to)', () => {
    renderFilter();
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(2);
  });

  it('generates options from 00:00 to 23:30 in 30-minute steps', () => {
    renderFilter();
    const selects = screen.getAllByRole('combobox');
    // 24 hours * 2 steps = 48 options (+1 placeholder = 49 if placeholder shown as option)
    const fromOptions = selects[0].querySelectorAll('option');
    // expect at least 48 time options
    expect(fromOptions.length).toBeGreaterThanOrEqual(48);
    // first real option is 00:00
    const realOptions = Array.from(fromOptions).filter((o) => (o as HTMLOptionElement).value !== '');
    expect((realOptions[0] as HTMLOptionElement).value).toBe('00:00');
    expect((realOptions[realOptions.length - 1] as HTMLOptionElement).value).toBe('23:30');
  });

  it('shows the correct selected value for from', () => {
    renderFilter({ from: '09:00' });
    const selects = screen.getAllByRole('combobox');
    expect((selects[0] as HTMLSelectElement).value).toBe('09:00');
  });

  it('shows the correct selected value for to', () => {
    renderFilter({ to: '17:30' });
    const selects = screen.getAllByRole('combobox');
    expect((selects[1] as HTMLSelectElement).value).toBe('17:30');
  });

  it('calls onFromChange when from select changes', () => {
    const onFromChange = vi.fn();
    renderFilter({ onFromChange });
    const selects = screen.getAllByRole('combobox');
    const fromSelect = selects[0] as HTMLSelectElement;
    // Simulate change event
    fromSelect.value = '08:00';
    fromSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onFromChange).toHaveBeenCalled();
  });

  it('calls onToChange when to select changes', () => {
    const onToChange = vi.fn();
    renderFilter({ onToChange });
    const selects = screen.getAllByRole('combobox');
    const toSelect = selects[1] as HTMLSelectElement;
    toSelect.value = '18:00';
    toSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onToChange).toHaveBeenCalled();
  });
});
