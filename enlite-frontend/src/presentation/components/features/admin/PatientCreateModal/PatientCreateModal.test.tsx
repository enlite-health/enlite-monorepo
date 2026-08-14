import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PatientCreateModal } from './PatientCreateModal';

/**
 * PatientCreateModal — country selector (abac-pais-fase1 task 5.1).
 *
 * The backend used to hardcode country:'AR' for admin-created patients, so a BR
 * patient was persisted as AR — invisible in BR-filtered views and filed under
 * the wrong legal regime (Ley 25.326 vs LGPD). Now the country is REQUIRED on
 * both sides. TypeScript already forces the field into CreatePatientPayload;
 * what it cannot catch is the runtime behaviour these tests pin:
 *
 *   a. The select is rendered, required, and starts with NO preselection
 *      (a default would reintroduce the exact bug, silently).
 *   b. Submitting without choosing a country does NOT call the API.
 *   c. Choosing Brasil sends country:'BR' — not 'AR'.
 */

const mockCreatePatient = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    createPatient: (...args: unknown[]) => mockCreatePatient(...args),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'es' },
  }),
}));

function renderModal() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<PatientCreateModal onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated };
}

function fillFirstName(value = 'Ana') {
  fireEvent.change(screen.getByTestId('pc-firstName'), { target: { value } });
}

function submit() {
  fireEvent.click(screen.getByTestId('pc-save'));
}

describe('PatientCreateModal — country selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePatient.mockResolvedValue({ id: 'pat-001' });
  });

  // ── a. Rendered, with no preselection ──────────────────────────────────────
  it('a. renders the country select with AR and BR and no preselected value', () => {
    renderModal();

    const select = screen.getByTestId('pc-country') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    // Empty = the placeholder option. A preselected 'AR' would silently
    // reintroduce the bug this task exists to kill.
    expect(select.value).toBe('');

    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(values).toContain('AR');
    expect(values).toContain('BR');
  });

  // ── b. Required — blocks submit ────────────────────────────────────────────
  it('b. does not call the API when no country was chosen', async () => {
    renderModal();
    fillFirstName();
    submit();

    // Give the resolver a chance to run before asserting the negative.
    await waitFor(() => {
      expect(mockCreatePatient).not.toHaveBeenCalled();
    });
  });

  it('b2. still blocks submit when the country is cleared back to the placeholder', async () => {
    renderModal();
    fillFirstName();
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'BR' } });
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: '' } });
    submit();

    await waitFor(() => {
      expect(mockCreatePatient).not.toHaveBeenCalled();
    });
  });

  // ── c. Chosen country reaches the payload verbatim ─────────────────────────
  it("c. sends country:'BR' when Brasil is chosen", async () => {
    renderModal();
    fillFirstName('João');
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'BR' } });
    submit();

    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'João', country: 'BR' }),
    );
  });

  it("c2. sends country:'AR' when Argentina is chosen", async () => {
    renderModal();
    fillFirstName();
    fireEvent.change(screen.getByTestId('pc-country'), { target: { value: 'AR' } });
    submit();

    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Ana', country: 'AR' }),
    );
  });
});
