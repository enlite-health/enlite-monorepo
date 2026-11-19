/**
 * JobsRadiusMap (096, CA-7, CA-10, DD-7): estados, chips e mapa. `PointsMap` é dublê (nunca o Google real).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerJobByRadius, WorkerJobsByRadius } from '@domain/entities/WorkerJobByRadius';
import type { WorkerJobsByRadiusState } from '@presentation/hooks/useWorkerJobsByRadius';
import { JobsRadiusMap } from './JobsRadiusMap';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const pointsMapProps = vi.fn();
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (props: Record<string, unknown>) => {
    pointsMapProps(props);
    return <div data-testid="points-map" data-map-status="unavailable"><span data-testid="points-map-placeholder">{String(props.placeholderText)}</span></div>;
  },
}));

const job = (id: string, d: number, nb: string | null): WorkerJobByRadius => ({
  id, case_number: 1, vacancy_number: 1, title: 't', service: null, neighborhood: nb, city: null, state: null, worker_type: [], distance_km: d, already_applied: false,
});
const data = (items: WorkerJobByRadius[], schedule = true): WorkerJobsByRadius & { center: { lat: number; lng: number } } => ({
  items, center: { lat: -34.6, lng: -58.38 }, applied: { schedule, profession: true, sex: true }, missing: [],
});
const ok = (items: WorkerJobByRadius[], schedule = true): WorkerJobsByRadiusState => ({ status: 'ok', data: data(items, schedule) });

beforeEach(() => { pointsMapProps.mockClear(); });

describe('JobsRadiusMap', () => {
  it('feliz: círculo (rings + fitRadiusKm + centro da zona), contagem e chips somam o total, inclusive "Sin barrio"', () => {
    const items = [job('1', 2, 'Palermo'), job('2', 3, 'Palermo'), job('3', 4, 'Recoleta'), job('4', 5, null), job('5', 40, 'Tigre')];
    render(<JobsRadiusMap state={ok(items)} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-count')).toHaveTextContent('"count":4');
    const chips = screen.getAllByTestId('radius-region').map((c) => c.textContent ?? '');
    expect(chips).toEqual(['Palermo · 2', 'Recoleta · 1', 'jobsRadius.noNeighborhood · 1']);
    expect(chips.reduce((s, c) => s + Number(c.split('·')[1]), 0)).toBe(4);
    const p = pointsMapProps.mock.calls[pointsMapProps.mock.calls.length - 1][0];
    expect(p.points).toEqual([]);
    expect(p.center).toEqual({ lat: -34.6, lng: -58.38 });
    expect(p.fitRadiusKm).toBe(10);
    expect(p.rings).toHaveLength(1);
    expect(p.centerIcon).toBe('house');
  });

  it('sem chave (mapa indisponível): placeholder assume e chips/contagem seguem', () => {
    render(<JobsRadiusMap state={ok([job('1', 2, 'Palermo')])} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('points-map')).toHaveAttribute('data-map-status', 'unavailable');
    expect(screen.getByTestId('points-map-placeholder')).toHaveTextContent('jobsRadius.mapUnavailable');
    expect(screen.getAllByTestId('radius-region')).toHaveLength(1);
  });

  it("cadastro incompleto ('incomplete') e sem usuário ('idle'): este componente não desenha nada (o aviso e a lista são da home)", () => {
    const { container, rerender } = render(<JobsRadiusMap state={{ status: 'incomplete', missing: ['address'] }} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<JobsRadiusMap state={{ status: 'idle' }} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
  });

  it('403 inativa e erro de rede → mensagem, sem mapa, nada quebra', () => {
    const { rerender } = render(<JobsRadiusMap state={{ status: 'inactive' }} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-inactive')).toBeInTheDocument();
    rerender(<JobsRadiusMap state={{ status: 'error' }} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-error')).toBeInTheDocument();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
  });

  it('0 vagas no raio → "ampliar" avança para a próxima parada (10 → 15)', () => {
    const onRadiusChange = vi.fn();
    render(<JobsRadiusMap state={ok([job('1', 30, 'Tigre')])} radiusKm={10} onRadiusChange={onRadiusChange} />);
    expect(screen.getByTestId('radius-empty')).toHaveTextContent('jobsRadius.empty:{"n":10}');
    fireEvent.click(screen.getByTestId('radius-widen'));
    expect(onRadiusChange).toHaveBeenCalledWith(15);
  });

  it('0 vagas na última parada (100 km): sem botão de ampliar', () => {
    render(<JobsRadiusMap state={ok([])} radiusKm={100} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('radius-widen')).not.toBeInTheDocument();
  });

  it('prestador sem disponibilidade declarada → aviso para completar; com disponibilidade, sem aviso', () => {
    const { rerender } = render(<JobsRadiusMap state={ok([], false)} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-availability-hint')).toBeInTheDocument();
    rerender(<JobsRadiusMap state={ok([], true)} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.queryByTestId('radius-availability-hint')).not.toBeInTheDocument();
  });

  it('carregando → esqueleto, sem mapa', () => {
    render(<JobsRadiusMap state={{ status: 'loading' }} radiusKm={10} onRadiusChange={vi.fn()} />);
    expect(screen.getByTestId('radius-loading')).toBeInTheDocument();
    expect(within(document.body).queryByTestId('points-map')).not.toBeInTheDocument();
  });

  it('DD-8: nenhum arquivo novo chama Geocoder nem places', () => {
    for (const f of ['JobsRadiusMap.tsx', 'RadiusSlider.tsx', 'useInView.ts', 'radiusScope.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(/Geocoder|places\./);
    }
  });
});
