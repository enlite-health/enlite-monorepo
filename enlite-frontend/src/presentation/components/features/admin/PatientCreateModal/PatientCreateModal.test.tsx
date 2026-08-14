import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
 *   d. The required-country error clears once the operator fixes it, so the
 *      form is not left permanently red after one bad submit.
 *
 * Groups e-h cover the rest of the drawer's runtime behaviour (save failure,
 * Escape/backdrop close, optional-field cleaning) — the paths the country work
 * left untested and that the coverage threshold requires.
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

function chooseCountry(value: string) {
  fireEvent.change(screen.getByTestId('pc-country'), { target: { value } });
}

/** The mocked `t` echoes the key, so this is the country error's rendered text. */
const COUNTRY_ERROR = 'admin.patients.create.countryRequired';

/** Opens the serviceType MultiSelect (a button/listbox, not a <select>). */
function openServiceTypes() {
  const wrapper = document.getElementById('pc-serviceType') as HTMLElement;
  fireEvent.click(within(wrapper).getByRole('button'));
  return wrapper;
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
    chooseCountry('AR');
    submit();

    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Ana', country: 'AR' }),
    );
  });

  // ── d. The error clears once the operator fixes it ─────────────────────────
  it('d. shows the required-country error on submit and clears it once a country is picked', async () => {
    renderModal();
    fillFirstName();
    submit();

    // The error surfaces (rendered by SelectField, once — not duplicated by FormField).
    const shown = await screen.findAllByText(COUNTRY_ERROR);
    expect(shown).toHaveLength(1);

    // Fixing the field must clear it, or the drawer stays red forever.
    chooseCountry('BR');
    await waitFor(() => {
      expect(screen.queryByText(COUNTRY_ERROR)).not.toBeInTheDocument();
    });

    // And the corrected form now goes through.
    submit();
    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'BR' }),
    );
  });

  it('d2. blocks submit and skips the API when firstName is empty', async () => {
    renderModal();
    chooseCountry('AR');
    submit();

    await waitFor(() => expect(screen.getByTestId('pc-firstName')).toBeInTheDocument());
    expect(mockCreatePatient).not.toHaveBeenCalled();
  });

  it('d3. blocks submit when the contact email is malformed', async () => {
    renderModal();
    fillFirstName();
    chooseCountry('AR');
    fireEvent.change(screen.getByTestId('pc-email'), { target: { value: 'not-an-email' } });
    submit();

    await waitFor(() => {
      expect(mockCreatePatient).not.toHaveBeenCalled();
    });
  });

  // ── e. Save failure is surfaced, not swallowed ─────────────────────────────
  // NOTE: the component tags this message with data-testid="pc-error", but the
  // Text atom only forwards its declared props, so the attribute never reaches
  // the DOM (TS does not flag hyphenated JSX attributes). Assert on the text.
  const SAVE_ERROR = 'admin.patients.create.saveError';

  it('e. shows the API error message when the save fails', async () => {
    mockCreatePatient.mockRejectedValueOnce(new Error('contacto obligatorio'));
    const { onCreated, onClose } = renderModal();
    fillFirstName();
    chooseCountry('AR');
    submit();

    expect(await screen.findByText('contacto obligatorio')).toBeInTheDocument();
    // A failed save must neither report a created patient nor close the drawer,
    // or the operator loses everything they typed.
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('e2. falls back to the generic message when the rejection is not an Error', async () => {
    mockCreatePatient.mockRejectedValueOnce('boom');
    renderModal();
    fillFirstName();
    chooseCountry('BR');
    submit();

    expect(await screen.findByText(SAVE_ERROR)).toBeInTheDocument();
  });

  it('e3. reports the new patient id and closes on success', async () => {
    const { onCreated, onClose } = renderModal();
    fillFirstName();
    chooseCountry('AR');
    submit();

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('pat-001'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText(SAVE_ERROR)).not.toBeInTheDocument();
  });

  // ── f. Closing paths ───────────────────────────────────────────────────────
  it('f. closes on Escape', async () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('f2. ignores other keys', async () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });

    // Wait past the CLOSE_MS timeout before asserting the negative.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('f3. closes when the backdrop is clicked', async () => {
    const { onClose } = renderModal();

    fireEvent.click(screen.getByTestId('patient-create-modal-backdrop'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // ── g. Optional fields are trimmed, and empties are dropped ────────────────
  it('g. trims the optional fields it sends and omits the blank ones', async () => {
    renderModal();
    fillFirstName('  Ana  ');
    chooseCountry('AR');
    fireEvent.change(screen.getByTestId('pc-lastName'), { target: { value: '  Silva  ' } });
    fireEvent.change(screen.getByTestId('pc-phone'), { target: { value: ' +5491100000 ' } });
    fireEvent.change(screen.getByTestId('pc-email'), { target: { value: 'ana@enlite.health' } });
    fireEvent.change(screen.getByTestId('pc-documentType'), { target: { value: 'DNI' } });
    fireEvent.change(screen.getByTestId('pc-documentNumber'), { target: { value: ' 12345678 ' } });
    fireEvent.change(screen.getByTestId('pc-insName'), { target: { value: ' OSDE ' } });
    fireEvent.change(screen.getByTestId('pc-insMember'), { target: { value: ' 99-1 ' } });
    submit();

    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith({
      firstName: 'Ana',
      country: 'AR',
      lastName: 'Silva',
      phoneWhatsapp: '+5491100000',
      contactEmail: 'ana@enlite.health',
      documentType: 'DNI',
      documentNumber: '12345678',
      healthInsuranceName: 'OSDE',
      healthInsuranceMemberId: '99-1',
      // Nothing was picked in the MultiSelect: an empty array is dropped, not sent as [].
      serviceType: undefined,
    });
  });

  it('g2. sends the selected service types', async () => {
    renderModal();
    fillFirstName();
    chooseCountry('AR');

    const wrapper = openServiceTypes();
    fireEvent.click(within(wrapper).getByText('AT'));
    fireEvent.click(within(wrapper).getByText('NURSE'));
    submit();

    await waitFor(() => expect(mockCreatePatient).toHaveBeenCalledTimes(1));
    expect(mockCreatePatient).toHaveBeenCalledWith(
      expect.objectContaining({ serviceType: ['AT', 'NURSE'] }),
    );
  });
});
