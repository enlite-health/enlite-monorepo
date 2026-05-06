import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

// Minimal TimeSelect mock so tests don't need the full atom
vi.mock('@presentation/components/atoms', () => ({
  TimeSelect: ({ value, onChange, className }: {
    value: string;
    onChange: (e: { target: { value: string } }) => void;
    className?: string;
  }) => (
    <select
      data-testid="time-select"
      value={value}
      onChange={(e) => onChange({ target: { value: e.target.value } })}
      className={className}
    >
      <option value="09:00">09:00</option>
      <option value="17:00">17:00</option>
      <option value="12:00">12:00</option>
    </select>
  ),
}));

import { VacancyDaySchedulePicker } from '../VacancyDaySchedulePicker';
import type { ScheduleValue } from '../../vacancyScheduleUtils';

const EMPTY_VALUE: ScheduleValue = [{ days: [], timeFrom: '', timeTo: '' }];

describe('VacancyDaySchedulePicker', () => {
  it('renders 7 day cards', () => {
    render(<VacancyDaySchedulePicker value={EMPTY_VALUE} onChange={vi.fn()} />);
    // Each day has a label key rendered via t() — check for lun through dom
    const days = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'];
    for (const d of days) {
      expect(
        screen.getByText(`admin.vacancyDetail.vacancyForm.days.${d}`),
      ).toBeInTheDocument();
    }
  });

  it('renders scheduleSlotsLabel when no slots', () => {
    render(<VacancyDaySchedulePicker value={EMPTY_VALUE} onChange={vi.fn()} />);
    const labels = screen.getAllByText('admin.vacancyModal.scheduleSlotsLabel');
    // At least 7 visible (one per day header + button aria-labels)
    expect(labels.length).toBeGreaterThanOrEqual(7);
  });

  it('calls onChange with new slot when add button is clicked', async () => {
    const onChange = vi.fn();
    render(<VacancyDaySchedulePicker value={EMPTY_VALUE} onChange={onChange} />);

    // Click the first add button (lun)
    const addButtons = screen.getAllByRole('button', {
      name: 'admin.vacancyModal.scheduleSlotsLabel',
    });
    await userEvent.click(addButtons[0]);

    expect(onChange).toHaveBeenCalledOnce();
    const newValue: ScheduleValue = onChange.mock.calls[0][0];
    const lunSlot = newValue.find((e) => e.days.includes('lun'));
    expect(lunSlot).toBeDefined();
    expect(lunSlot?.timeFrom).toBe('09:00');
    expect(lunSlot?.timeTo).toBe('17:00');
  });

  it('renders time selects when slot exists', () => {
    const value: ScheduleValue = [{ days: ['mar'], timeFrom: '09:00', timeTo: '17:00' }];
    render(<VacancyDaySchedulePicker value={value} onChange={vi.fn()} />);
    const selects = screen.getAllByTestId('time-select');
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onChange with slot removed when remove button is clicked', async () => {
    const onChange = vi.fn();
    const value: ScheduleValue = [{ days: ['mie'], timeFrom: '09:00', timeTo: '17:00' }];
    render(<VacancyDaySchedulePicker value={value} onChange={onChange} />);

    // Remove buttons have aria-label "admin.vacancyModal.scheduleRemoveSlot"
    const removeBtn = screen.getByRole('button', {
      name: 'admin.vacancyModal.scheduleRemoveSlot',
    });
    await userEvent.click(removeBtn);

    expect(onChange).toHaveBeenCalledOnce();
    const newValue: ScheduleValue = onChange.mock.calls[0][0];
    const mieSlot = newValue.find((e) => e.days.includes('mie'));
    expect(mieSlot).toBeUndefined();
  });

  it('renders error message when error prop is provided', () => {
    render(
      <VacancyDaySchedulePicker
        value={EMPTY_VALUE}
        onChange={vi.fn()}
        error="Schedule is required"
      />,
    );
    expect(screen.getByText('Schedule is required')).toBeInTheDocument();
  });

  it('does not render error when error prop is absent', () => {
    render(<VacancyDaySchedulePicker value={EMPTY_VALUE} onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('calls onChange with updated startTime when TimeSelect changes', async () => {
    const onChange = vi.fn();
    const value: ScheduleValue = [{ days: ['jue'], timeFrom: '09:00', timeTo: '17:00' }];
    render(<VacancyDaySchedulePicker value={value} onChange={onChange} />);

    const [startSelect] = screen.getAllByTestId('time-select');
    await userEvent.selectOptions(startSelect, '12:00');

    expect(onChange).toHaveBeenCalledOnce();
    const newValue: ScheduleValue = onChange.mock.calls[0][0];
    const jueSlot = newValue.find((e) => e.days.includes('jue'));
    expect(jueSlot?.timeFrom).toBe('12:00');
  });
});
