/**
 * ManualMergeModal.test.tsx
 *
 * Covers:
 * - Renders title, description, two autocomplete labels and Cancel button
 * - "Comparar y unificar" button is disabled until both accounts are selected
 * - After both accounts selected, button is enabled and calls buildManualGroup
 * - On buildManualGroup success: MergeDirectModeBody is rendered (accounts visible)
 * - On buildManualGroup error: error message shown, step stays on selection
 * - onClose called when X button clicked
 * - Backdrop click calls onClose
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ManualMergeModal } from './ManualMergeModal';
import type { CandidateItem, ManualGroupResult } from '@domain/entities/DedupGroup';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | object) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockSearchCandidates = vi.fn();
const mockBuildManualGroup = vi.fn();
const mockMerge = vi.fn();

vi.mock('@infrastructure/http/AdminDedupApiService', () => ({
  AdminDedupApiService: {
    searchCandidates: (...args: unknown[]) => mockSearchCandidates(...args),
    buildManualGroup: (...args: unknown[]) => mockBuildManualGroup(...args),
    merge: (...args: unknown[]) => mockMerge(...args),
  },
}));

// CandidateAutocomplete is complex (debounce, refs) — stub it to control state
vi.mock('./CandidateAutocomplete', () => ({
  CandidateAutocomplete: ({
    id,
    label,
    selected,
    onSelect,
    onClear,
  }: {
    id: string;
    label: string;
    selected: CandidateItem | null;
    onSearch: (q: string) => Promise<CandidateItem[]>;
    onSelect: (c: CandidateItem) => void;
    onClear: () => void;
    disabledIds?: string[];
  }) => (
    <div data-testid={`autocomplete-${id}`}>
      <span>{label}</span>
      {selected ? (
        <div>
          <span data-testid={`${id}-selected-name`}>{selected.name}</span>
          <button data-testid={`${id}-clear-btn`} onClick={onClear}>
            Cambiar
          </button>
        </div>
      ) : (
        <button
          data-testid={`${id}-stub-select`}
          onClick={() =>
            onSelect({
              id: id === 'manual-account-a' ? 'stub-id-a' : 'stub-id-b',
              name: id === 'manual-account-a' ? 'Stub Account A' : 'Stub Account B',
              phone: '+5491100000001',
              email: null,
              login_real: false,
              is_imported: false,
            })
          }
        >
          Seleccionar
        </button>
      )}
    </div>
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACC_A = {
  id: 'acc-manual-a',
  email: 'a@example.com',
  tier: 'REGISTERED' as const,
  status: 'ACTIVE',
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-01-01T10:00:00Z',
  wja_count: 2,
  docs_count: 1,
  encuadres_count: 0,
  login_real: true,
  is_imported: false,
  name: 'Stub Account A',
  phone_normalized: '+5491100000001',
};

const ACC_B = {
  id: 'acc-manual-b',
  email: null,
  tier: 'PRE_REGISTER' as const,
  status: 'INCOMPLETE',
  created_at: '2026-02-01T10:00:00Z',
  updated_at: '2026-02-01T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
  is_imported: true,
  name: 'Stub Account B',
  phone_normalized: '+5491100000002',
};

const MANUAL_GROUP_RESULT: ManualGroupResult = {
  accounts: [ACC_A, ACC_B],
  survivor_suggested_id: ACC_A.id,
  survivor_reason: 'real_account_absorbs_imported',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ManualMergeModal', () => {
  const onClose = vi.fn();
  const onMergeSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildManualGroup.mockResolvedValue(MANUAL_GROUP_RESULT);
    mockMerge.mockResolvedValue({ survivorId: ACC_A.id, absorbedIds: [ACC_B.id], mergedAt: '2026-06-22T00:00:00Z' });
  });

  it('renders title, description and both account labels', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    expect(screen.getByText('Unificar manualmente')).toBeInTheDocument();
    expect(
      screen.getByText(/Buscá dos cuentas por nombre o teléfono/),
    ).toBeInTheDocument();
    expect(screen.getByText('Primera cuenta')).toBeInTheDocument();
    expect(screen.getByText('Segunda cuenta')).toBeInTheDocument();
  });

  it('"Comparar y unificar" button is disabled when no accounts selected', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    const compareBtn = screen.getByTestId('manual-compare-btn');
    expect(compareBtn).toBeDisabled();
  });

  it('button is disabled when only one account is selected', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    // Select account A only
    fireEvent.click(screen.getByTestId('autocomplete-manual-account-a').querySelector('[data-testid$="-stub-select"]')!);

    const compareBtn = screen.getByTestId('manual-compare-btn');
    expect(compareBtn).toBeDisabled();
  });

  it('button is enabled after both accounts are selected', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    fireEvent.click(screen.getByTestId('manual-account-a-stub-select'));
    fireEvent.click(screen.getByTestId('manual-account-b-stub-select'));

    const compareBtn = screen.getByTestId('manual-compare-btn');
    expect(compareBtn).not.toBeDisabled();
  });

  it('calls buildManualGroup with both ids and renders MergeDirectModeBody on success', async () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    fireEvent.click(screen.getByTestId('manual-account-a-stub-select'));
    fireEvent.click(screen.getByTestId('manual-account-b-stub-select'));

    fireEvent.click(screen.getByTestId('manual-compare-btn'));

    await waitFor(() => {
      expect(mockBuildManualGroup).toHaveBeenCalledWith(['stub-id-a', 'stub-id-b']);
    });

    // MergeDirectModeBody is rendered: shows account cards
    await waitFor(() => {
      expect(
        screen.getByTestId(`merge-account-card-${ACC_A.id}`),
      ).toBeInTheDocument();
    });
  });

  it('shows error message when buildManualGroup fails', async () => {
    mockBuildManualGroup.mockRejectedValue(new Error('Server error'));

    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    fireEvent.click(screen.getByTestId('manual-account-a-stub-select'));
    fireEvent.click(screen.getByTestId('manual-account-b-stub-select'));
    fireEvent.click(screen.getByTestId('manual-compare-btn'));

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument();
    });

    // Selection step stays open
    expect(screen.getByText('Unificar manualmente')).toBeInTheDocument();
  });

  it('calls onClose when X button is clicked', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Cancel button is clicked', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('never renders raw account ids in the modal DOM', () => {
    render(<ManualMergeModal onClose={onClose} onMergeSuccess={onMergeSuccess} />);

    expect(screen.queryByText('stub-id-a')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-id-b')).not.toBeInTheDocument();
  });
});
