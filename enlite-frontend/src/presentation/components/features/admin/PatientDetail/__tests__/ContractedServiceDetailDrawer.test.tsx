/**
 * ContractedServiceDetailDrawer — detalhe SÓ-LEITURA de um serviço contratado (05/09, decisão
 * do Gabriel: a tabela mostra o essencial; o clique na linha mostra tudo). i18n REAL (molde
 * `sex-both-i18n.test.tsx`) + guard de enum cru.
 */
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
  providersNeeded: null, authorizedHours: null, weeklyHours: null, careLocation: null,
  hourlyValue: null, hourlyValueRedacted: false, startDate: null,
  contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
  providerAgeBand: null, addressId: null, schedule: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: [], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

describe('ContractedServiceDetailDrawer', () => {
  it('serviço mínimo: todo campo vazio vira "—"/rótulo; sem badge de baixa; sem perfil', () => {
    const { container } = render(<ContractedServiceDetailDrawer service={BASE} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId('svc-detail-devices').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-providers-needed').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-location').textContent).toContain('—');
    expect(screen.getByTestId('svc-detail-address').textContent).toContain('Sin domicilio vinculado');
    expect(screen.getByTestId('svc-detail-schedule').textContent).toContain('Sin horario');
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('—');
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
      hourlyValue: 1200,
      providers: [
        { id: 'p1', serviceId: 'svc-1', workerId: 'w1', workerName: null, weeklyHours: 10, active: true, endedAt: null, country: 'AR', createdAt: '', updatedAt: '' },
        { id: 'p2', serviceId: 'svc-1', workerId: 'w2', workerName: 'Beto', weeklyHours: null, active: true, endedAt: null, country: 'AR', createdAt: '', updatedAt: '' },
        { id: 'p3', serviceId: 'svc-1', workerId: 'w3', workerName: 'Fora', weeklyHours: 5, active: false, endedAt: '2026-09-01', country: 'AR', createdAt: '', updatedAt: '' },
      ],
    };
    const { container } = render(<ContractedServiceDetailDrawer service={svc} addresses={[]} onClose={vi.fn()} />);
    expect(screen.getByText('Baja')).toBeTruthy();
    expect(screen.getByTestId('svc-detail-devices').textContent).toContain('Domiciliario');
    expect(screen.getByTestId('svc-detail-devices').textContent).not.toContain('HOME');
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('1200');
    expect(screen.getByTestId('svc-detail-start').textContent).not.toContain('—');
    const providers = screen.getByTestId('svc-detail-providers');
    expect(providers.textContent).toContain('(2 / 2)'); // 2 ativos de 2 necessários — o inativo não conta
    expect(providers.textContent).toContain('10 h');
    expect(providers.textContent).toContain('Beto');
    expect(providers.textContent).not.toContain('Fora');
    expectNoRawEnumLeaks(container);
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
