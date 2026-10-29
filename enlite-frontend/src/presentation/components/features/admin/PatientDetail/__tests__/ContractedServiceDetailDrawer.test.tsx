/**
 * ContractedServiceDetailDrawer — detalhe SÓ-LEITURA de um serviço contratado (05/09, decisão
 * do Gabriel: a tabela mostra o essencial; o clique na linha mostra tudo). i18n REAL (molde
 * `sex-both-i18n.test.tsx`) + guard de enum cru.
 */
import { CONTRACT_058_DEFAULTS, LINKED_058 } from '@domain/entities/__tests__/fixtures/contractedService058';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ContractedServiceDetailDrawer } from '../ContractedServiceDetailDrawer';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const BASE: PatientContractedServiceDetail = {
  id: 'svc-1', patientId: 'pat-1', serviceCode: 'CAREGIVER', professionalProfile: null,
  providersNeeded: null, authorization: null, scheduleHours: 0, careLocation: null,
  ...CONTRACT_058_DEFAULTS, startDate: null, supervisionFrequency: null, guardShift: null,
  providerAgeBand: null, requiredProfessions: null, requiredSex: null, requiredExperience: null, workerAttributes: null, workSchedule: null, paymentDay: null, dailyObs: null, addressId: null, schedule: null, liveVacancy: null, liveVacancyRedacted: false,
  active: true, endedAt: null, country: 'AR', deviceTypes: [], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

describe('ContractedServiceDetailDrawer', () => {
  it('não mostra horas autorizadas (a autorização corrente mora no editor; o legado saiu)', () => {
    render(<ContractedServiceDetailDrawer service={{ ...BASE, authorization: { id: 'a1', hours: 40, validFrom: '2026-01-01', validTo: '2026-12-31' } }} addresses={[]} onClose={vi.fn()} />);
    expect(screen.queryByTestId('svc-detail-authorized-hours')).toBeNull();
  });

  it('serviço mínimo: todo campo vazio vira "—"/rótulo; sem badge de baixa; sem perfil', () => {
    const { container } = render(<ContractedServiceDetailDrawer service={BASE} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId('svc-detail-devices').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-providers-needed').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-location').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-address').textContent).toContain('Sin domicilio vinculado');
    expect(screen.getByTestId('svc-detail-schedule').textContent).toContain('Sin horario');
    // Sem vínculo (todo serviço de hoje): preço/imposto/pagador dizem que NÃO há contrato — não um "—" que pareça preço vazio.
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('Sin contrato vinculado');
    expect(screen.getByTestId('svc-detail-contract').textContent).toContain('Sin contrato vinculado');
    expect(screen.getByTestId('svc-detail-iva').textContent).toContain('Sin contrato vinculado');
    expect(screen.getByTestId('svc-detail-coverage-match').getAttribute('data-state')).toBe('NO_PAYER');
    expect(screen.getByTestId('svc-detail-start').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-providers').textContent).toContain('(0)');
    expect(screen.queryByText('Baja')).toBeNull();
    expect(screen.queryByTestId('svc-detail-profile')).toBeNull();
    expectNoRawEnumLeaks(container);
  });

  it('serviço em BAIXA com dispositivos e prestadores (um sem nome, um sem horas): badge, lista traduzida e "—" nos buracos', () => {
    const svc: PatientContractedServiceDetail = {
      ...BASE,
      active: false,
      endedAt: '2026-09-02T00:00:00Z',
      deviceTypes: ['HOME', 'SCHOOL'],
      providersNeeded: 2,
      startDate: '2026-09-01T00:00:00.000Z',
      ...LINKED_058,
      price: { state: 'OK', hourlyRate: 1200, currency: 'ARS' },
      providers: [
        { id: 'p1', serviceId: 'svc-1', workerId: 'w1', workerName: null, active: true, endedAt: null, country: 'AR', createdAt: '', updatedAt: '' },
        { id: 'p2', serviceId: 'svc-1', workerId: 'w2', workerName: 'Beto', active: true, endedAt: null, country: 'AR', createdAt: '', updatedAt: '' },
        { id: 'p3', serviceId: 'svc-1', workerId: 'w3', workerName: 'Fora', active: false, endedAt: '2026-09-01', country: 'AR', createdAt: '', updatedAt: '' },
      ],
    };
    const { container } = render(<ContractedServiceDetailDrawer service={svc} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByText('Baja')).toBeTruthy();
    expect(screen.getByTestId('svc-detail-devices').textContent).toContain('Domiciliario');
    expect(screen.getByTestId('svc-detail-devices').textContent).not.toContain('HOME');
    expect(screen.getByTestId('svc-detail-value').textContent).toMatch(/1\.?200/);
    expect(screen.getByTestId('svc-detail-start').textContent).not.toContain('—');
    const providers = screen.getByTestId('svc-detail-providers');
    expect(providers.textContent).toContain('(2 / 2)'); // 2 ativos de 2 necessários — o inativo não conta
    expect(providers.textContent).not.toContain('h/sem'); // 056: sem horas por prestador
    expect(providers.textContent).not.toContain('10 h');
    expect(screen.queryByTestId('svc-detail-weekly-hours')).toBeNull();
    expect(screen.getByTestId('svc-detail-schedule-hours').textContent).toContain('0');
    expect(providers.textContent).toContain('Beto');
    expect(providers.textContent).not.toContain('Fora');
    expectNoRawEnumLeaks(container);
  });

  // ── Spec 058: pagador, preço, imposto e divergência vêm do VÍNCULO e do termo vigente (somente leitura) ─────────────
  it('serviço VINCULADO: obra social — contrato, preço e imposto do termo (0 = isento) e a divergência, tudo traduzido', () => {
    const svc = { ...BASE, ...LINKED_058, tax: { state: 'OK', taxRatePercent: 0 } } as PatientContractedServiceDetail;
    const { container } = render(<ContractedServiceDetailDrawer service={svc} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId('svc-detail-contract').textContent).toContain('OSDE — Plan 210');
    expect(screen.getByTestId('svc-detail-value').textContent).toMatch(/1\.?500/);
    expect(screen.getByTestId('svc-detail-iva').textContent).toContain('Exento (0 %)');
    expect(screen.getByTestId('svc-detail-coverage-match').getAttribute('data-state')).toBe('MATCH');
    expectNoRawEnumLeaks(container);
  });

  it('sem a célula de preço: cadeado, nunca o número; o imposto continua; sem `coverage` os nomes somem e a divergência é REDACTED', () => {
    const svc = {
      ...BASE, ...LINKED_058,
      payer: { state: 'LINKED', isPrivate: false, validFrom: '2026-09-01', validTo: null, names: null },
      price: { state: 'REDACTED' }, coverageMatch: { state: 'REDACTED' },
    } as PatientContractedServiceDetail;
    render(<ContractedServiceDetailDrawer service={svc} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('🔒');
    expect(screen.getByTestId('svc-detail-value').textContent).not.toMatch(/1\.?500/);
    expect(screen.getByTestId('svc-detail-iva').textContent).toContain('21');
    expect(screen.getByTestId('svc-detail-contract').textContent).toContain('no visible con tu permiso');
    expect(screen.getByTestId('svc-detail-coverage-match').getAttribute('data-state')).toBe('REDACTED');
  });

  it('pagador particular sem permissão de nomes: "Particular"; termo ausente: a frase de "sem término vigente"', () => {
    const svc = {
      ...BASE, ...LINKED_058,
      payer: { state: 'LINKED', isPrivate: true, validFrom: '2026-09-01', validTo: null, names: null },
      price: { state: 'NO_TERM' }, tax: { state: 'NO_TERM' }, coverageMatch: { state: 'REDACTED' },
    } as PatientContractedServiceDetail;
    render(<ContractedServiceDetailDrawer service={svc} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId('svc-detail-contract').textContent).toContain('Particular');
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('Sin término vigente hoy');
    expect(screen.getByTestId('svc-detail-iva').textContent).toContain('Sin término vigente hoy');
  });

  it('desmontar durante a animação de fechar cancela o timer — onClose NÃO dispara órfão (gate 06/09)', () => {
    const onClose = vi.fn();
    const { unmount } = render(<ContractedServiceDetailDrawer service={BASE} addresses={[]} onClose={onClose} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-detail-close'));
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onClose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('desmontar SEM ter fechado não tem timer para cancelar (nada quebra)', () => {
    const { unmount } = render(<ContractedServiceDetailDrawer service={BASE} addresses={[]} onClose={vi.fn()} />);
    expect(() => unmount()).not.toThrow();
  });

  it('fechar pelo X chama onClose depois da animação (CLOSE_MS)', () => {
    const onClose = vi.fn();
    render(<ContractedServiceDetailDrawer service={BASE} addresses={[]} onClose={onClose} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-detail-close'));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
