/**
 * ActivatePatientButton — cobertura completa (D200: arquivo tocado). O comportamento
 * pré-existente (visibilidade por status, confirmar/cancelar, sucesso, 422 genérico) não tinha
 * teste dedicado nesta árvore; a mudança NOVA desta sessão (spec 014 US-D1) é o tratamento de
 * `err.details.missing` — os MESMOS códigos/i18n do checklist, nunca o texto cru do servidor.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import { ActivatePatientButton } from '../ActivatePatientButton';

const activatePatient = vi.fn();
const showToast = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { activatePatient: (...a: unknown[]) => activatePatient(...a) },
}));
vi.mock('@presentation/hooks/useToast', () => ({ useToast: () => showToast }));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  activatePatient.mockReset();
  showToast.mockReset();
});

describe('ActivatePatientButton — visibilidade por status', () => {
  it('status null → não renderiza nada', () => {
    const { container } = render(<ActivatePatientButton patientId="p1" status={null} onActivated={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('status ACTIVE (fora de ACTIVATABLE) → não renderiza', () => {
    const { container } = render(<ActivatePatientButton patientId="p1" status="ACTIVE" onActivated={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('status ADMISSION → botão visível', () => {
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });

  it('status PENDING_ADMISSION → botão visível', () => {
    render(<ActivatePatientButton patientId="p1" status="PENDING_ADMISSION" onActivated={vi.fn()} />);
    expect(screen.getByTestId('activate-patient-btn')).toBeInTheDocument();
  });
});

describe('ActivatePatientButton — abrir/cancelar/backdrop', () => {
  it('clicar no botão abre o modal de confirmação', async () => {
    const user = userEvent.setup();
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    expect(screen.getByTestId('activate-confirm-modal')).toBeInTheDocument();
  });

  it('"Cancelar" fecha o modal sem chamar a API', async () => {
    const user = userEvent.setup();
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-cancel'));
    expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument();
    expect(activatePatient).not.toHaveBeenCalled();
  });

  it('clicar no backdrop fecha o modal (quando não está ocupado)', async () => {
    const user = userEvent.setup();
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm-backdrop'));
    expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument();
  });

  it('reabrir o modal limpa o erro anterior', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(new Error('boom'));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    await user.click(screen.getByTestId('activate-cancel'));
    await user.click(screen.getByTestId('activate-patient-btn'));
    expect(screen.queryByTestId('activate-error')).not.toBeInTheDocument();
  });
});

describe('ActivatePatientButton — sucesso', () => {
  it('confirma → toast de sucesso com a contagem, fecha o modal, chama onActivated', async () => {
    const user = userEvent.setup();
    const onActivated = vi.fn();
    activatePatient.mockResolvedValueOnce({ patientId: 'p1', status: 'ACTIVE', createdVacancyIds: ['v1', 'v2'] });
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={onActivated} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('2'), 'success');
    expect(screen.queryByTestId('activate-confirm-modal')).not.toBeInTheDocument();
  });
});

describe('ActivatePatientButton — spec 014 US-D1: erro 422 com missing (checklist)', () => {
  it('missing com 1 código → mensagem traduzida do código, não o texto cru do backend', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(
      new PatientApiError('cru do servidor', 422, { code: 'PATIENT_NOT_READY', details: { missing: ['CONSENT'] } }),
    );
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent('Consentimiento');
    expect(screen.getByTestId('activate-error').textContent).not.toContain('cru do servidor');
  });

  it('missing com vários códigos → todos aparecem na mensagem', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(
      new PatientApiError('x', 422, { code: 'PATIENT_NOT_READY', details: { missing: ['ADDRESS', 'CONSENT'] } }),
    );
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    const text = screen.getByTestId('activate-error').textContent ?? '';
    expect(text).toContain('Domicilio');
    expect(text).toContain('Consentimiento');
  });

  it('422 SEM `details.missing` (formato antigo) → cai na mensagem "sem dirección"', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(new PatientApiError('x', 422));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent(/localización/i);
  });

  it('422 com `details.missing` vazio ([]) → mesmo comportamento do formato antigo', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(new PatientApiError('x', 422, { details: { missing: [] } }));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent(/localización/i);
  });
});

describe('ActivatePatientButton — outros erros', () => {
  it('erro genérico (não PatientApiError, é Error) → mostra err.message', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(new Error('falha de rede'));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent('falha de rede');
  });

  it('rejeição não-Error (string) → cai no texto genérico traduzido', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce('string crua');
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent(/no se pudo activar/i);
  });

  it('PatientApiError com status != 422 → cai no ramo genérico (err.message)', async () => {
    const user = userEvent.setup();
    activatePatient.mockRejectedValueOnce(new PatientApiError('500 interno', 500));
    render(<ActivatePatientButton patientId="p1" status="ADMISSION" onActivated={vi.fn()} />);
    await user.click(screen.getByTestId('activate-patient-btn'));
    await user.click(screen.getByTestId('activate-confirm'));
    await waitFor(() => expect(screen.getByTestId('activate-error')).toBeInTheDocument());
    expect(screen.getByTestId('activate-error')).toHaveTextContent('500 interno');
  });
});
