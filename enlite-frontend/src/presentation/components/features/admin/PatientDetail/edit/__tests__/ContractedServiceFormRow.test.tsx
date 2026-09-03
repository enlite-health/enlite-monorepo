/**
 * ContractedServiceFormRow — form de UM serviço contratado (spec 013, bloco C).
 * Cria (POST) quando `service` é null, atualiza (PATCH, Merge Patch) quando existe; baixa
 * (active:false, confirm); hourlyValue desabilitado quando o backend redigiu (lex C-c.4).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractedServiceFormRow, deactivateService } from '../ContractedServiceFormRow';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    createContractedService: (...a: unknown[]) => mockCreate(...a),
    updateContractedService: (...a: unknown[]) => mockUpdate(...a),
  },
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { listWorkers: vi.fn().mockResolvedValue({ data: [] }) },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const SERVICE: PatientContractedServiceDetail = {
  id: 's1', patientId: 'pat1', serviceCode: 'AT', professionalProfile: 'perfil sintético',
  providersNeeded: 2, authorizedHours: 20, weeklyHours: 20, careLocation: 'HOME',
  hourlyValue: 1500, hourlyValueRedacted: false, version: 'v1', startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL', taxCondition: 'IVA_EXEMPT', supervisionFrequency: 'DAYS_30', guardShift: 'MORNING',
  active: true, endedAt: null, country: 'AR', deviceTypes: ['HOME'], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

const confirmSpy = vi.spyOn(window, 'confirm');

describe('ContractedServiceFormRow', () => {
  beforeEach(() => { vi.clearAllMocks(); confirmSpy.mockReturnValue(true); });

  it('modo NOVO: mostra o formulário vazio, sem seção de prestadores, com botão cancelar', () => {
    render(<ContractedServiceFormRow patientId="pat1" service={null} index={1} onSaved={vi.fn()} onCancelNew={vi.fn()} />);
    expect(screen.getByTestId('contracted-service-new')).toBeTruthy();
    expect(screen.queryByTestId(/providers-section-/)).toBeNull();
    expect(screen.getByTestId('contracted-service-new-cancel')).toBeTruthy();
  });

  it('modo NOVO: cancelar chama onCancelNew', () => {
    const onCancelNew = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" service={null} index={1} onSaved={vi.fn()} onCancelNew={onCancelNew} />);
    fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
    expect(onCancelNew).toHaveBeenCalled();
  });

  it('modo NOVO: salvar chama createContractedService com o serviceCode escolhido, onSaved é chamado', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" service={null} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'CAREGIVER' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0]).toBe('pat1');
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ serviceCode: 'CAREGIVER' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo NOVO: erro ao criar mostra mensagem', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-new-error')).toBeTruthy());
  });

  it('modo EXISTENTE: pré-carrega os campos do serviço, código desabilitado (imutável)', () => {
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect((screen.getByTestId('svc-code-1') as HTMLSelectElement).value).toBe('AT');
    expect(screen.getByTestId('svc-code-1')).toBeDisabled();
    expect((screen.getByTestId('svc-providersNeeded-1') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('svc-profile-1') as HTMLTextAreaElement).value).toBe('perfil sintético');
    expect(screen.getByTestId('providers-section-s1')).toBeTruthy();
  });

  it('modo EXISTENTE: editar um campo e salvar chama updateContractedService (PATCH) com o serviceId', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-weeklyHours-1'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ weeklyHours: 25 })));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: hourlyValue redigido (lex C-c.4) fica DESABILITADO e o submit NUNCA envia a chave', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    const redacted = { ...SERVICE, hourlyValue: null, hourlyValueRedacted: true };
    render(<ContractedServiceFormRow patientId="pat1" service={redacted} index={1} onSaved={vi.fn()} />);
    const field = screen.getByTestId('svc-hourlyValue-1') as HTMLInputElement;
    expect(field).toBeDisabled();
    expect(field.value).toContain('Solo admin');
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][2].hourlyValue).toBeUndefined();
  });

  it('modo EXISTENTE: hourlyValue NÃO redigido é editável e o submit envia o número digitado', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-hourlyValue-1'), { target: { value: '2000' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ hourlyValue: 2000 })));
  });

  it('modo EXISTENTE: limpar um campo numérico envia null (nunca NaN)', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providersNeeded: null })));
  });

  it('modo EXISTENTE: "Dar de baja" pede confirmação; confirmando, chama updateContractedService({active:false})', async () => {
    mockUpdate.mockResolvedValue({ ...SERVICE, active: false });
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: "Dar de baja" cancelado no confirm NÃO chama a API', () => {
    confirmSpy.mockReturnValue(false);
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('modo EXISTENTE: serviço já INATIVO não mostra o botão "Dar de baja", mostra o rótulo de baixa', () => {
    render(<ContractedServiceFormRow patientId="pat1" service={{ ...SERVICE, active: false }} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-deactivate-s1')).toBeNull();
    expect(screen.getByText(/Dado de baja/i)).toBeTruthy();
  });

  it('modo EXISTENTE: erro ao atualizar mostra mensagem', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-error-s1')).toBeTruthy());
  });

  it('sem data-testid de cancelar quando onCancelNew não é passado (não-novo)', () => {
    render(<ContractedServiceFormRow patientId="pat1" service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-new-cancel')).toBeNull();
  });

  // ── `deactivateService` (QA-caça #4): o guarda `if (!service) return` é INALCANÇÁVEL via
  // clique simulado — o botão que o chama só existe no DOM quando `service` já é não-null (ver
  // docblock da função). Testado diretamente, sem renderizar nada. ────────────────────────────

  it('deactivateService(null, ...): retorna sem confirmar, sem chamar a API (branch antes inalcançável)', async () => {
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(null, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, onSaved });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('deactivateService(SERVICE, ...): confirmando, chama updateContractedService({active:false}) e onSaved', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockResolvedValue({});
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(SERVICE, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, onSaved });
    expect(confirmSpy).toHaveBeenCalledWith('confirma?');
    expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });
});
