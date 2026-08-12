import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimeSelect } from '../TimeSelect';

vi.mock('lucide-react', () => ({
  ChevronDown: () => <svg data-testid="chevron" />,
}));

describe('TimeSelect', () => {
  // ── Value display ──────────────────────────────────────────────────────────

  it('displays the provided value in the trigger button', () => {
    render(<TimeSelect value="09:00" />);
    expect(screen.getByRole('button')).toHaveTextContent('09:00');
  });

  it('displays 14:30 when value is 14:30', () => {
    render(<TimeSelect value="14:30" />);
    expect(screen.getByRole('button')).toHaveTextContent('14:30');
  });

  it('displays 23:30 when value is 23:30', () => {
    render(<TimeSelect value="23:30" />);
    expect(screen.getByRole('button')).toHaveTextContent('23:30');
  });

  it('displays placeholder when value is empty', () => {
    render(<TimeSelect value="" />);
    expect(screen.getByRole('button')).toHaveTextContent('--:--');
  });

  it('displays custom placeholder when provided', () => {
    render(<TimeSelect value="" placeholder="Seleccionar" />);
    expect(screen.getByRole('button')).toHaveTextContent('Seleccionar');
  });

  it('never displays 00:00 when value is 09:00', () => {
    render(<TimeSelect value="09:00" />);
    expect(screen.getByRole('button')).not.toHaveTextContent('00:00');
    expect(screen.getByRole('button')).toHaveTextContent('09:00');
  });

  it('never displays 00:00 when value is 17:00', () => {
    render(<TimeSelect value="17:00" />);
    expect(screen.getByRole('button')).not.toHaveTextContent('00:00');
    expect(screen.getByRole('button')).toHaveTextContent('17:00');
  });

  // ── Edge cases: backend format with seconds ────────────────────────────────

  it('normalizes "09:00:00" (with seconds) to display "09:00"', () => {
    render(<TimeSelect value="09:00:00" />);
    expect(screen.getByRole('button')).toHaveTextContent('09:00');
    expect(screen.getByRole('button').textContent).not.toContain('09:00:00');
  });

  it('normalizes "17:30:00" (with seconds) to display "17:30"', () => {
    render(<TimeSelect value="17:30:00" />);
    expect(screen.getByRole('button')).toHaveTextContent('17:30');
  });

  it('highlights correct option when value has seconds format', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00:00" />);

    await user.click(screen.getByRole('button'));

    const listItems = screen.getByRole('list').querySelectorAll('button');
    const selected = Array.from(listItems).find((b) => b.textContent === '09:00');
    expect(selected).toBeDefined();
    expect(selected!.className).toContain('bg-primary text-white');
  });

  // ── Dropdown behavior ──────────────────────────────────────────────────────

  it('does not show dropdown list initially', () => {
    render(<TimeSelect value="09:00" />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows dropdown list after clicking the trigger', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('renders 288 time options with step=5 (default)', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" />);

    await user.click(screen.getByRole('button'));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(288);
  });

  it('renders 48 time options with step=30', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" step={30} />);

    await user.click(screen.getByRole('button'));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(48);
  });

  it('renders 24 time options with step=60', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" step={60} />);

    await user.click(screen.getByRole('button'));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(24);
  });

  it('renders 96 time options with step=15', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" step={15} />);

    await user.click(screen.getByRole('button'));

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(96);
  });

  // ── Selection ──────────────────────────────────────────────────────────────

  it('calls onChange with selected time value', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<TimeSelect value="09:00" onChange={handleChange} />);

    await user.click(screen.getByRole('button'));

    const option14 = screen.getAllByRole('button').find((b) => b.textContent === '14:00');
    expect(option14).toBeDefined();
    await user.click(option14!);

    expect(handleChange).toHaveBeenCalledWith({ target: { value: '14:00' } });
  });

  it('closes the dropdown after selecting a value', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('list')).toBeInTheDocument();

    const option = screen.getAllByRole('button').find((b) => b.textContent === '10:00');
    await user.click(option!);

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  // ── Highlight ──────────────────────────────────────────────────────────────

  it('highlights the currently selected value in the dropdown', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" />);

    await user.click(screen.getByRole('button'));

    const listItems = screen.getByRole('list').querySelectorAll('button');
    const selected = Array.from(listItems).find((b) => b.textContent === '09:00');
    expect(selected).toBeDefined();
    expect(selected!.className).toContain('bg-primary text-white');
  });

  it('does not highlight non-selected values', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" />);

    await user.click(screen.getByRole('button'));

    const listItems = screen.getByRole('list').querySelectorAll('button');
    const other = Array.from(listItems).find((b) => b.textContent === '10:00');
    expect(other).toBeDefined();
    expect(other!.className).toContain('text-gray-700');
  });

  // ── Disabled state ─────────────────────────────────────────────────────────

  it('does not open dropdown when disabled', async () => {
    const user = userEvent.setup();
    render(<TimeSelect value="09:00" disabled />);

    await user.click(screen.getByRole('button'));

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  // ── Multiple instances preserve their own values ───────────────────────────

  it('two TimeSelects with different values display their own values', () => {
    render(
      <div>
        <TimeSelect value="08:00" />
        <TimeSelect value="17:30" />
      </div>,
    );

    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('08:00');
    expect(buttons[1]).toHaveTextContent('17:30');
  });
});
