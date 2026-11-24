/**
 * JobsRadius (096, CA-7, CA-11): módulo puro de escopo por raio + controle de raio de 6 paradas.
 * Contagem por raio = itens com `distance_km <= r`; chips por barrio somam o total (inclui "Sin barrio").
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WorkerJobByRadius } from '@domain/entities/WorkerJobByRadius';
import { JOB_RADII_KM } from '@domain/entities/WorkerJobByRadius';
import { groupByRegion, itemsWithin, nearestFallback, nextRadius } from './radiusScope';
import { RadiusSlider } from './RadiusSlider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const job = (id: string, distance_km: number, neighborhood: string | null, city: string | null = null): WorkerJobByRadius => ({
  id, case_number: 1, vacancy_number: 1, title: 't', service: null, neighborhood, city, state: null, worker_type: [], distance_km, already_applied: false,
});

const ITEMS = [
  job('a', 3, 'Palermo'), job('b', 5, 'palermo '), job('c', 9.9, 'Recoleta'), job('d', 10, null, 'Quilmes'),
  job('e', 10.1, null, null), job('f', 49, 'Tigre'), job('g', 100, 'Lanús'),
];

describe('radiusScope', () => {
  it('as 6 paradas são 5·10·15·20·50·100', () => {
    expect([...JOB_RADII_KM]).toEqual([5, 10, 15, 20, 50, 100]);
  });

  it.each([[5, 2], [10, 4], [15, 5], [20, 5], [50, 6], [100, 7]])('raio %i km → %i vagas (distance_km <= r)', (r, n) => {
    expect(itemsWithin(ITEMS, r)).toHaveLength(n);
  });

  it('nextRadius avança para a próxima parada e termina em null', () => {
    expect(nextRadius(10)).toBe(15);
    expect(nextRadius(50)).toBe(100);
    expect(nextRadius(100)).toBeNull();
  });

  it('chips: barrio com grafias diferentes agrupa; sem barrio cai na cidade; sem os dois vira grupo "" (mostrado); soma = total', () => {
    const regions = groupByRegion(itemsWithin(ITEMS, 100));
    expect(regions.reduce((s, r) => s + r.count, 0)).toBe(7);
    expect(regions.find((r) => r.key === 'palermo')?.count).toBe(2);
    expect(regions.find((r) => r.key === 'quilmes')?.count).toBe(1);
    expect(regions.find((r) => r.key === '')).toMatchObject({ label: '', count: 1 });
    expect(regions[0].key).toBe('palermo');
  });

  it('grupo com 1 vaga aparece (sem mínimo na V1)', () => {
    expect(groupByRegion([job('x', 1, 'Barrio Único')])).toEqual([{ key: 'barrio unico', label: 'Barrio Único', count: 1 }]);
  });
});

describe('RadiusSlider', () => {
  it('6 paradas, aria-valuetext, contagem e mudança por teclado/arrasto', () => {
    const onChange = vi.fn();
    render(<RadiusSlider value={10} count={4} onChange={onChange} />);
    const range = screen.getByTestId('radius-range') as HTMLInputElement;
    expect(range.min).toBe('0');
    expect(range.max).toBe('5');
    expect(range.value).toBe('1');
    expect(range).toHaveAttribute('aria-valuetext', 'jobsRadius.upTo:{"n":10}');
    expect(screen.getByTestId('radius-count')).toHaveTextContent('jobsRadius.count:{"count":4}');
    fireEvent.change(range, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith(50);
  });
});

describe('nearestFallback (096)', () => {
  const far = [job('x', 197, 'Luján')];
  it('items vazio + nearest cheio → nearest', () => expect(nearestFallback({ items: [], nearest: far })).toEqual(far));
  it('items cheio → null mesmo com nearest', () => expect(nearestFallback({ items: ITEMS, nearest: far })).toBeNull());
  it('nearest ausente/vazio → null', () => {
    expect(nearestFallback({ items: [] })).toBeNull();
    expect(nearestFallback({ items: [], nearest: [] })).toBeNull();
  });
});
