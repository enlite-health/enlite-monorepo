/**
 * PatientContractedServicesEditDrawer — lista + formulário por serviço (spec 013, bloco C).
 * Fonte de verdade é o REFETCH próprio (não `patient.contractedServices` estático), porque o
 * drawer fica aberto durante várias mutações seguidas.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { PatientContractedServicesEditDrawer } from '../PatientContractedServicesEditDrawer';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const mockList = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    listContractedServices: (...a: unknown[]) => mockList(...a),
    createContractedService: vi.fn(),
    updateContractedService: vi.fn(),
    associateProvider: vi.fn(),
    updateProvider: vi.fn(),
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
  id: 's1', patientId: patientDetailFixture.id, serviceCode: 'AT', professionalProfile: null,
  providersNeeded: 2, authorizedHours: 20, weeklyHours: 20, careLocation: 'HOME',
  hourlyValue: 1500, hourlyValueRedacted: false, version: null, startDate: null,
  contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: [], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

describe('PatientContractedServicesEditDrawer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta e busca a lista atual (não confia em patient.contractedServices estático)', async () => {
    mockList.mockResolvedValue([SERVICE]);
    const patient = { ...patientDetailFixture, contractedServices: [] };
    render(<PatientContractedServicesEditDrawer patient={patient} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(patientDetailFixture.id));
    await waitFor(() => expect(screen.getByTestId('contracted-service-form-s1')).toBeTruthy());
  });

  it('sem serviços (e sem "+ Nuevo" aberto): mostra o empty state', async () => {
    mockList.mockResolvedValue([]);
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contracted-services-empty')).toBeTruthy());
  });

  it('erro ao buscar a lista mostra mensagem, sem quebrar o drawer', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('contracted-services-load-error')).toBeTruthy());
  });

  it('"+ Nuevo servicio" abre o form novo e some o botão; cancelar no form fecha e o botão volta', async () => {
    mockList.mockResolvedValue([]);
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => screen.getByTestId('contracted-services-empty'));
    fireEvent.click(screen.getByTestId('contracted-service-add'));
    expect(screen.getByTestId('contracted-service-new')).toBeTruthy();
    expect(screen.queryByTestId('contracted-service-add')).toBeNull();
    fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
    expect(screen.queryByTestId('contracted-service-new')).toBeNull();
    expect(screen.getByTestId('contracted-service-add')).toBeTruthy();
  });

  it('salvar um serviço refetch a lista LOCALMENTE, mas NÃO chama onSaved do pai ainda (evita fechar o drawer no meio de uma sessão de várias mutações)', async () => {
    mockList.mockResolvedValueOnce([SERVICE]).mockResolvedValueOnce([SERVICE, { ...SERVICE, id: 's2' }]);
    const onSaved = vi.fn();
    const { AdminContractedServicesApiService } = await import('@infrastructure/http/AdminContractedServicesApiService');
    (AdminContractedServicesApiService.updateContractedService as ReturnType<typeof vi.fn>).mockResolvedValue(SERVICE);
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => screen.getByTestId('contracted-service-form-s1'));
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('contracted-service-form-s2')).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('fechar DEPOIS de ter salvo algo (dirty) chama onSaved do pai — refetch da página só acontece ao sair', async () => {
    vi.useFakeTimers();
    mockList.mockResolvedValueOnce([SERVICE]).mockResolvedValueOnce([SERVICE]);
    const { AdminContractedServicesApiService } = await import('@infrastructure/http/AdminContractedServicesApiService');
    (AdminContractedServicesApiService.updateContractedService as ReturnType<typeof vi.fn>).mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={onSaved} />);
    await vi.waitFor(() => expect(screen.getByTestId('contracted-service-form-s1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await vi.waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByLabelText('Cerrar'));
    vi.advanceTimersByTime(300);
    expect(onSaved).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fechar SEM ter salvo nada (não dirty) não chama onSaved do pai', async () => {
    vi.useFakeTimers();
    mockList.mockResolvedValue([]);
    const onSaved = vi.fn();
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByLabelText('Cerrar'));
    vi.advanceTimersByTime(300);
    expect(onSaved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fechar (X) esconde o drawer após a transição', async () => {
    vi.useFakeTimers();
    mockList.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    const closeBtn = screen.getByLabelText('Cerrar');
    fireEvent.click(closeBtn);
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('Escape fecha o drawer', async () => {
    vi.useFakeTimers();
    mockList.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clicar no backdrop fecha o drawer', async () => {
    vi.useFakeTimers();
    mockList.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('patient-contracted-services-edit-backdrop'));
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): a UNIÃO do dirty das linhas decide a confirmação ──
  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('editar um campo de um serviço existente → backdrop abre confirmação em vez de fechar', async () => {
      mockList.mockResolvedValue([SERVICE]);
      render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      await screen.findByTestId(`contracted-service-form-${SERVICE.id}`);
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '6' } });
      fireEvent.click(screen.getByTestId('patient-contracted-services-edit-backdrop'));
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-keep-editing'));
      expect(screen.getByTestId('svc-providersNeeded-1')).toHaveValue(6);
    });

    it('abrir "+ Nuevo servicio" sem digitar nada → Escape fecha direto (form novo ainda não é dirty)', async () => {
      mockList.mockResolvedValue([]);
      render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('contracted-service-add'));
      expect(screen.getByTestId('contracted-service-new')).toBeVisible();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('digitar no "+ Nuevo servicio" → Escape abre confirmação; "Descartar" fecha de verdade', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockList.mockResolvedValue([]);
      const onClose = vi.fn();
      render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={onClose} onSaved={vi.fn()} />);
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('contracted-service-add'));
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '3' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.getByTestId('discard-changes-confirm')).toBeVisible();
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      vi.advanceTimersByTime(300);
      expect(onClose).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('cancelar o "+ Nuevo servicio" limpa o dirty — Escape volta a fechar direto', async () => {
      mockList.mockResolvedValue([]);
      render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('contracted-service-add'));
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '3' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });

    it('salvar um serviço existente com sucesso volta a ficar limpo — Escape fecha direto depois', async () => {
      mockList.mockResolvedValueOnce([SERVICE]).mockResolvedValueOnce([{ ...SERVICE, providersNeeded: 5 }]);
      const { AdminContractedServicesApiService } = await import('@infrastructure/http/AdminContractedServicesApiService');
      (AdminContractedServicesApiService.updateContractedService as ReturnType<typeof vi.fn>).mockResolvedValue({});
      render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} onClose={vi.fn()} onSaved={vi.fn()} />);
      await screen.findByTestId(`contracted-service-form-${SERVICE.id}`);
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '5' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(AdminContractedServicesApiService.updateContractedService).toHaveBeenCalled());
      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).not.toBeInTheDocument();
    });
  });
});
