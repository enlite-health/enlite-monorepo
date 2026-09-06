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
  providerAgeBand: 'AGE_30_45',
  addressId: null,
  schedule: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: ['HOME'], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

const ADDRESS_BASE = {
  addressType: 'primary', complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true,
  neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR',
};
const ADDRESSES = [
  { ...ADDRESS_BASE, id: 'addr-home', addressFormatted: 'Rua Augusta, 975 - Centro', addressRaw: null },
  { ...ADDRESS_BASE, id: 'addr-school', addressFormatted: null, addressRaw: 'Av. Cruzeiro do Sul, 1212', isPrimary: false, displayOrder: 2 },
];

const confirmSpy = vi.spyOn(window, 'confirm');

describe('ContractedServiceFormRow', () => {
  beforeEach(() => { vi.clearAllMocks(); confirmSpy.mockReturnValue(true); });

  it('modo NOVO: mostra o formulário vazio, sem seção de prestadores, com botão cancelar', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} onCancelNew={vi.fn()} />);
    expect(screen.getByTestId('contracted-service-new')).toBeTruthy();
    expect(screen.queryByTestId(/providers-section-/)).toBeNull();
    expect(screen.getByTestId('contracted-service-new-cancel')).toBeTruthy();
  });

  it('modo NOVO: cancelar chama onCancelNew', () => {
    const onCancelNew = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} onCancelNew={onCancelNew} />);
    fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
    expect(onCancelNew).toHaveBeenCalled();
  });

  it('modo NOVO: salvar chama createContractedService com o serviceCode escolhido, onSaved é chamado', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'CAREGIVER' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0]).toBe('pat1');
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ serviceCode: 'CAREGIVER' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  // Spec 015 (US-A6.1): franja etária solicitada do prestador — select no drawer.
  it('modo NOVO: escolher providerAgeBand e salvar envia o valor escolhido', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.change(screen.getByTestId('svc-providerAgeBand-1'), { target: { value: 'AGE_30_45' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ providerAgeBand: 'AGE_30_45' });
  });

  it('modo NOVO: sem escolher providerAgeBand, envia null (nunca string vazia)', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ providerAgeBand: null });
  });

  it('modo NOVO: erro ao criar mostra mensagem', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-new-error')).toBeTruthy());
  });

  it('modo EXISTENTE: pré-carrega os campos do serviço, código desabilitado (imutável)', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect((screen.getByTestId('svc-code-1') as HTMLSelectElement).value).toBe('AT');
    expect(screen.getByTestId('svc-code-1')).toBeDisabled();
    expect((screen.getByTestId('svc-providersNeeded-1') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('svc-profile-1') as HTMLTextAreaElement).value).toBe('perfil sintético');
    expect((screen.getByTestId('svc-providerAgeBand-1') as HTMLSelectElement).value).toBe('AGE_30_45');
    expect(screen.getByTestId('providers-section-s1')).toBeTruthy();
  });

  it('modo EXISTENTE: editar um campo e salvar chama updateContractedService (PATCH) com o serviceId', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-weeklyHours-1'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ weeklyHours: 25 })));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: editar providerAgeBand e salvar chama updateContractedService com o novo valor', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-providerAgeBand-1'), { target: { value: 'AGE_45_PLUS' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providerAgeBand: 'AGE_45_PLUS' })));
  });

  it('modo EXISTENTE: hourlyValue redigido (lex C-c.4) fica DESABILITADO e o submit NUNCA envia a chave', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    const redacted = { ...SERVICE, hourlyValue: null, hourlyValueRedacted: true };
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={redacted} index={1} onSaved={vi.fn()} />);
    const field = screen.getByTestId('svc-hourlyValue-1') as HTMLInputElement;
    expect(field).toBeDisabled();
    expect(field.value).toContain('Solo admin');
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][2].hourlyValue).toBeUndefined();
  });

  it('modo EXISTENTE: hourlyValue NÃO redigido é editável e o submit envia o número digitado', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-hourlyValue-1'), { target: { value: '2000' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ hourlyValue: 2000 })));
  });

  it('modo EXISTENTE: limpar um campo numérico envia null (nunca NaN)', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providersNeeded: null })));
  });

  it('modo EXISTENTE: "Dar de baja" pede confirmação; confirmando, chama updateContractedService({active:false})', async () => {
    mockUpdate.mockResolvedValue({ ...SERVICE, active: false });
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: "Dar de baja" cancelado no confirm NÃO chama a API', () => {
    confirmSpy.mockReturnValue(false);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('modo EXISTENTE: serviço já INATIVO não mostra o botão "Dar de baja", mostra o rótulo de baixa', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, active: false }} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-deactivate-s1')).toBeNull();
    expect(screen.getByText(/Dado de baja/i)).toBeTruthy();
  });

  it('modo EXISTENTE: erro ao atualizar mostra mensagem', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-error-s1')).toBeTruthy());
  });

  /**
   * F4 (gate `revisao-pr`, MÉDIO ×3) — `deactivateService` tinha `try/finally` SEM `catch`. O
   * componente TEM canal de erro (`setError`, renderizado ao lado do botão Salvar) que este
   * caminho nunca usava: a operadora confirmava a baixa do serviço, o PATCH falhava, e o único
   * sinal era o spinner parando. Ela acreditava ter dado baixa.
   */
  it('F4: "Dar de baja" que FALHA usa o canal de erro que já existe no componente', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockRejectedValue(new Error('HTTP 500'));
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-error-s1')).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('sem data-testid de cancelar quando onCancelNew não é passado (não-novo)', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-new-cancel')).toBeNull();
  });

  // ── `deactivateService` (QA-caça #4): o guarda `if (!service) return` é INALCANÇÁVEL via
  // clique simulado — o botão que o chama só existe no DOM quando `service` já é não-null (ver
  // docblock da função). Testado diretamente, sem renderizar nada. ────────────────────────────

  it('deactivateService(null, ...): retorna sem confirmar, sem chamar a API (branch antes inalcançável)', async () => {
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(null, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError: vi.fn(), errorMessage: 'erro', onSaved });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('F4: deactivateService com a API falhando reporta pelo `setError` e NÃO chama onSaved', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockRejectedValue(new Error('boom'));
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    const setError = vi.fn();
    await deactivateService(SERVICE, {
      patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError,
      errorMessage: 'no se pudo dar de baja', onSaved,
    });
    expect(setError).toHaveBeenLastCalledWith('no se pudo dar de baja');
    expect(onSaved).not.toHaveBeenCalled();
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });

  it('deactivateService(SERVICE, ...): confirmando, chama updateContractedService({active:false}) e onSaved', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockResolvedValue({});
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(SERVICE, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError: vi.fn(), errorMessage: 'erro', onSaved });
    expect(confirmSpy).toHaveBeenCalledWith('confirma?');
    expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): a linha avisa o pai quando fica dirty ───────────
  describe('onDirtyChange (US-D4)', () => {
    it('editar um campo chama onDirtyChange(true)', () => {
      const onDirtyChange = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} onDirtyChange={onDirtyChange} />);
      onDirtyChange.mockClear();
      fireEvent.change(screen.getByTestId('svc-version-1'), { target: { value: 'v2' } });
      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it('salvar com sucesso volta a chamar onDirtyChange(false) — o form fica limpo de novo', async () => {
      mockUpdate.mockResolvedValue({ ...SERVICE, version: 'v2' });
      const onDirtyChange = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} onDirtyChange={onDirtyChange} />);
      fireEvent.change(screen.getByTestId('svc-version-1'), { target: { value: 'v2' } });
      expect(onDirtyChange).toHaveBeenCalledWith(true);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    });

    it('sem onDirtyChange (prop opcional ausente) não quebra ao editar', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      expect(() => fireEvent.change(screen.getByTestId('svc-version-1'), { target: { value: 'v2' } })).not.toThrow();
    });
  });

  // ── Migration 330 (decisão do Gabriel 05/09): endereço (ponteiro) e horário do encuadre ────
  describe('endereço e horário (migration 330)', () => {
    it('o select "Domicilio" lista SÓ os endereços da ficha, com o rótulo do geocoder ou o texto cru', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels).toContain('Rua Augusta, 975 - Centro');
      expect(labels).toContain('Av. Cruzeiro do Sul, 1212');
      expect(select.disabled).toBe(false);
    });

    it('sem endereço na ficha: o select fica desabilitado E um aviso âmbar diz que o paciente NÃO tem domicílio (Gabriel, 06/09)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={[]} service={null} index={1} onSaved={vi.fn()} />);
      expect((screen.getByTestId('svc-addressId-1') as HTMLSelectElement).disabled).toBe(true);
      const aviso = screen.getByTestId('svc-address-none-1');
      expect(aviso).toHaveAttribute('role', 'alert');
      expect(aviso.textContent).toContain('no tiene domicilio cargado');
    });

    it('com endereço na ficha: sem o aviso âmbar; o campo ocupa a linha inteira (col-span-2)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('svc-address-none-1')).toBeNull();
      const campo = screen.getByTestId('svc-addressId-1').closest('.sm\\:col-span-2');
      expect(campo).not.toBeNull();
    });

    it('campos numéricos avisam ao receber letra (NumericField nos 4: prestadores, hs semanais, hs autorizadas, valor)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      for (const id of ['svc-providersNeeded-1', 'svc-weeklyHours-1', 'svc-authorizedHours-1', 'svc-hourlyValue-1']) {
        fireEvent.keyDown(screen.getByTestId(id), { key: 'a' });
      }
      expect(screen.getAllByText('Este campo acepta solo números.')).toHaveLength(4);
      expect(screen.getAllByText('Solo números')).toHaveLength(4);
    });

    it('modo NOVO: escolher o endereço envia addressId; sem escolher envia null (nunca string vazia)', async () => {
      mockCreate.mockResolvedValue(SERVICE);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][1]).toMatchObject({ addressId: null, schedule: null });

      mockCreate.mockClear();
      fireEvent.change(screen.getByTestId('svc-addressId-1'), { target: { value: 'addr-school' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][1]).toMatchObject({ addressId: 'addr-school' });
    });

    it('modo EXISTENTE: hidrata o endereço e o horário do serviço; trocar o endereço e salvar envia o novo addressId', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      const svc = { ...SERVICE, addressId: 'addr-home', schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect((screen.getByTestId('svc-addressId-1') as HTMLSelectElement).value).toBe('addr-home');
      // O editor de horário (o MESMO da vaga, `DayScheduleEditor`) mostra o slot hidratado na
      // segunda-feira (dayOfWeek 1 → 'monday'): existe o botão de remover do slot 0.
      expect(screen.getByTestId('day-schedule-remove-monday-0')).toBeTruthy();

      fireEvent.change(screen.getByTestId('svc-addressId-1'), { target: { value: 'addr-school' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][2]).toMatchObject({
        addressId: 'addr-school',
        schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      });
    });

    it('modo EXISTENTE: serviço cujo endereço foi arquivado (fora da ficha) mostra o select vazio — e salvar sem escolher envia null', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      const svc = { ...SERVICE, addressId: 'addr-arquivado' };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).not.toContain('addr-arquivado');
      fireEvent.change(select, { target: { value: '' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][2]).toMatchObject({ addressId: null });
    });

    it('adicionar um slot no editor de horário e salvar envia o array no formato da vaga ({dayOfWeek, startTime, endTime})', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      // O DayScheduleEditor expõe um "+" por dia; domingo é dayOfWeek 0 e nasce 09:00-17:00.
      fireEvent.click(screen.getByTestId('day-schedule-add-sunday'));
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      const sent = mockUpdate.mock.calls[0][2].schedule;
      expect(Array.isArray(sent)).toBe(true);
      expect(sent[0]).toMatchObject({ dayOfWeek: 0, startTime: '09:00', endTime: '17:00' });
    });
  });
});
