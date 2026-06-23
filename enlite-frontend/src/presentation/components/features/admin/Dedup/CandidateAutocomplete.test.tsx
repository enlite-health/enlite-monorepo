/**
 * CandidateAutocomplete.test.tsx
 *
 * Covers:
 * - Initial state: renders input with placeholder, no dropdown
 * - Short query (<2 chars): no search called, no dropdown
 * - Query ≥2 chars: calls onSearch after debounce, shows dropdown options
 * - Each option shows NAME and PHONE — NOT raw id
 * - badge "Con acceso" shown for login_real=true
 * - badge "Importado" shown for is_imported=true
 * - Selecting an option calls onSelect and hides dropdown
 * - After selection: chip shows name + phone + Cambiar button
 * - Cambiar button calls onClear
 * - "Sin resultados" shown when onSearch returns []
 * - disabledIds hides the matching candidate from options
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CandidateAutocomplete } from './CandidateAutocomplete';
import type { CandidateAutocompleteProps } from './CandidateAutocomplete';
import type { CandidateItem } from '@domain/entities/DedupGroup';

// ── i18n mock ─────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | object) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CANDIDATE_A: CandidateItem = {
  id: 'cand-001',
  name: 'María González',
  phone: '+5491112345678',
  email: 'maria@example.com',
  login_real: true,
  is_imported: false,
};

const CANDIDATE_B: CandidateItem = {
  id: 'cand-002',
  name: 'Carlos Importado',
  phone: '+5491199990000',
  email: null,
  login_real: false,
  is_imported: true,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildProps(
  overrides: Partial<CandidateAutocompleteProps> = {},
): CandidateAutocompleteProps {
  return {
    id: 'test-ac',
    label: 'Primera cuenta',
    selected: null,
    onSearch: vi.fn().mockResolvedValue([CANDIDATE_A, CANDIDATE_B]),
    onSelect: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CandidateAutocomplete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders input and label, no dropdown initially', () => {
    const props = buildProps();
    render(<CandidateAutocomplete {...props} />);

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByText('Primera cuenta')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does NOT call onSearch for queries shorter than 2 chars', async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    const props = buildProps({ onSearch });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'M' } });
    await act(async () => { await vi.runAllTimersAsync(); });

    expect(onSearch).not.toHaveBeenCalled();
  });

  it('calls onSearch and shows dropdown with name + phone after debounce', async () => {
    const onSearch = vi.fn().mockResolvedValue([CANDIDATE_A]);
    const props = buildProps({ onSearch });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'María' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    expect(onSearch).toHaveBeenCalledWith('María');
    // Name visible
    expect(screen.getByText('María González')).toBeInTheDocument();
    // Phone visible
    expect(screen.getByText('+5491112345678')).toBeInTheDocument();
    // Raw id NOT visible
    expect(screen.queryByText('cand-001')).not.toBeInTheDocument();
  });

  it('shows "Con acceso" badge for login_real=true candidates', async () => {
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([CANDIDATE_A]),
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ma' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    expect(screen.getByText('Con acceso')).toBeInTheDocument();
  });

  it('shows "Importado" badge for is_imported=true candidates', async () => {
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([CANDIDATE_B]),
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ca' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    expect(screen.getByText('Importado')).toBeInTheDocument();
  });

  it('calls onSelect and hides dropdown when option is clicked', async () => {
    const onSelect = vi.fn();
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([CANDIDATE_A]),
      onSelect,
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ma' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    fireEvent.click(screen.getByText('María González'));
    expect(onSelect).toHaveBeenCalledWith(CANDIDATE_A);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows chip with name and phone when selected is provided', () => {
    const props = buildProps({ selected: CANDIDATE_A });
    render(<CandidateAutocomplete {...props} />);

    expect(screen.getByText('María González')).toBeInTheDocument();
    expect(screen.getByText('+5491112345678')).toBeInTheDocument();
    // Input is not rendered in chip mode
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('calls onClear when Cambiar button is clicked on chip', () => {
    const onClear = vi.fn();
    const props = buildProps({ selected: CANDIDATE_A, onClear });
    render(<CandidateAutocomplete {...props} />);

    fireEvent.click(screen.getByTestId('test-ac-clear-btn'));
    expect(onClear).toHaveBeenCalled();
  });

  it('shows no-results message when onSearch returns empty array', async () => {
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([]),
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'xyz' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    expect(
      screen.getByText('Sin resultados para la búsqueda.'),
    ).toBeInTheDocument();
  });

  it('hides candidates whose id is in disabledIds', async () => {
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([CANDIDATE_A, CANDIDATE_B]),
      disabledIds: ['cand-001'],
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ma' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // CANDIDATE_A is disabled — must NOT appear in dropdown
    expect(screen.queryByText('María González')).not.toBeInTheDocument();
    // CANDIDATE_B is not disabled — must appear
    expect(screen.getByText('Carlos Importado')).toBeInTheDocument();
  });

  it('never renders raw candidate id in the DOM', async () => {
    const props = buildProps({
      onSearch: vi.fn().mockResolvedValue([CANDIDATE_A, CANDIDATE_B]),
    });
    render(<CandidateAutocomplete {...props} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Ca' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });

    // Raw ids must not be visible
    expect(screen.queryByText('cand-001')).not.toBeInTheDocument();
    expect(screen.queryByText('cand-002')).not.toBeInTheDocument();
  });
});
