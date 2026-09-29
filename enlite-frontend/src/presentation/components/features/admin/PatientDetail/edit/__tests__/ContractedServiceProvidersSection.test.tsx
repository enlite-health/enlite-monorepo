/**
 * ContractedServiceProvidersSection — alocação anterior ao itinerário, SÓ LEITURA (Fase 14, DX-14.2).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractedServiceProvidersSection } from '../ContractedServiceProvidersSection';
import type { PatientContractedServiceProvider } from '@domain/entities/PatientDetail';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const ACTIVE: PatientContractedServiceProvider = {
  id: 'p1', serviceId: 's1', workerId: 'w1', workerName: 'Ana Fixture', weeklyHours: 10,
  active: true, endedAt: null, country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const ENDED: PatientContractedServiceProvider = {
  ...ACTIVE, id: 'p2', workerId: 'w2', workerName: null, weeklyHours: null, active: false, endedAt: '2026-09-10T00:00:00Z',
};

describe('ContractedServiceProvidersSection (só leitura)', () => {
  it('sem linha antiga: não renderiza nada', () => {
    const { container } = render(<ContractedServiceProvidersSection serviceId="s1" providers={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('providers-section-s1')).toBeNull();
  });

  it('com linhas antigas: seção rotulada, uma linha por prestador, ativo e baixado', () => {
    render(<ContractedServiceProvidersSection serviceId="s1" providers={[ACTIVE, ENDED]} />);
    expect(screen.getAllByTestId('providers-section-s1')).toHaveLength(1);
    expect(screen.getAllByTestId(/^provider-row-/)).toHaveLength(2);
    expect(screen.getByText('Asignación anterior al itinerario (solo lectura)')).toBeTruthy();
    const active = screen.getByTestId('provider-row-p1').textContent ?? '';
    expect(active).toContain('Ana Fixture');
    expect(active).toContain('10h/sem');
    expect(active).toContain('Activo');
    const ended = screen.getByTestId('provider-row-p2').textContent ?? '';
    expect(ended).toContain('Dado de baja');
  });

  it('sem nome cai no rótulo único do prestador (workerLabel: 8 últimos do id); sem horas mostra —', () => {
    const noName = { ...ENDED, workerId: 'aaaaaaaa-0000-4000-8000-00001234abcd' };
    render(<ContractedServiceProvidersSection serviceId="s1" providers={[noName]} />);
    const row = screen.getByTestId('provider-row-p2').textContent ?? '';
    expect(row).toContain('Prestador sin nombre · 1234abcd');
    expect(row).not.toContain(noName.workerId);
    expect(row).toContain('—h/sem');
  });

  it('nenhum botão, nenhum input, nenhum testid de ação', () => {
    const { container } = render(<ContractedServiceProvidersSection serviceId="s1" providers={[ACTIVE, ENDED]} />);
    expect(container.querySelectorAll('button, input')).toHaveLength(0);
    expect(screen.queryAllByTestId(/provider-(search|hit|associate|deactivate|weekly-hours)-|providers-empty-/)).toEqual([]);
  });
});
