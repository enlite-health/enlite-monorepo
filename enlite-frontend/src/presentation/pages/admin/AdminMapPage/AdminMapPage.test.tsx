/**
 * AdminMapPage.test.tsx — a página com os hooks e o mapa substituídos: o que
 * se afirma é a composição (abas, filtros → corpo da request, contagens,
 * lista, centro por paciente/clique, seleção).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminMapPage } from './AdminMapPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object') {
        let s = String(opts.defaultValue ?? key);
        for (const [k, v] of Object.entries(opts)) s = s.replace(`{{${k}}}`, String(v));
        return s;
      }
      return key;
    },
  }),
}));

const mockWorkers = vi.fn<[unknown], unknown>();
const mockPatients = vi.fn<[unknown], unknown>();
vi.mock('@hooks/admin/useMapPoints', () => ({
  useWorkersMapPoints: (f: unknown) => mockWorkers(f),
  usePatientsMapPoints: (f: unknown) => mockPatients(f),
}));

// O mapa vira um botão que simula o clique do usuário e um marcador do selecionado
const mapProps = vi.fn<[unknown], void>();
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (props: { points: Array<{ id: string; title: string }>; center: { lat: number; lng: number }; radiusKm: number; onCenterChange: (c: { lat: number; lng: number }) => void; selectedId: string | null; onSelect: (id: string | null) => void }) => {
    mapProps(props);
    return (
      <div data-testid="fake-map" data-center={`${props.center.lat},${props.center.lng}`} data-radius={props.radiusKm} data-selected={props.selectedId ?? ''} data-points={props.points.map((p) => p.id).join(',')}>
        <button data-testid="fake-map-click" onClick={() => props.onCenterChange({ lat: -34.7, lng: -58.5 })}>click</button>
        <button data-testid="fake-map-select" onClick={() => props.onSelect(props.points[0]?.id ?? null)}>select</button>
      </div>
    );
  },
}));

const W = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `W ${id}`, lat: -34.6, lng: -58.4, status: 'REGISTERED', documentsComplete: true, profession: 'AT', city: 'CABA', neighborhood: 'Flores', state: 'BA', distanceKm: 1.2, ...over });
const PT = (id: string, over: Record<string, unknown> = {}) => ({ id, addressId: `a-${id}`, name: `P ${id}`, lat: -34.61, lng: -58.41, status: 'ACTIVE', addressType: 'primary', city: 'CABA', neighborhood: null, state: 'BA', openVacancies: 1, distanceKm: 0.4, ...over });

const okWorkers: { points: ReturnType<typeof W>[]; total: number; withoutCoordinates: number; truncated: boolean; isLoading: boolean; error: string | null; refetch: () => void } = { points: [W('1'), W('2', { status: 'INCOMPLETE_REGISTER', lat: null, lng: null, city: null, neighborhood: null, distanceKm: null, profession: null })], total: 2, withoutCoordinates: 1, truncated: false, isLoading: false, error: null, refetch: vi.fn() };
const okPatients: { points: ReturnType<typeof PT>[]; total: number; withoutCoordinates: number; truncated: boolean; isLoading: boolean; error: string | null; refetch: () => void } = { points: [PT('9'), PT('8', { addressId: null, lat: null, lng: null, city: null, openVacancies: 0, distanceKm: null })], total: 2, withoutCoordinates: 1, truncated: true, isLoading: false, error: null, refetch: vi.fn() };

function setup(workers = okWorkers, patients = okPatients) {
  mockWorkers.mockReturnValue(workers);
  mockPatients.mockReturnValue(patients);
  return render(<MemoryRouter><AdminMapPage /></MemoryRouter>);
}

const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
const lastWorkersFilters = () => mockWorkers.mock.calls[mockWorkers.mock.calls.length - 1]?.[0] as Record<string, unknown>;
const lastPatientsFilters = () => last(mockPatients.mock.calls.filter((c) => (c[0] as { radius_km: number }).radius_km !== 100))?.[0] as Record<string, unknown>;
const lastPickerFilters = () => last(mockPatients.mock.calls.filter((c) => (c[0] as { radius_km: number }).radius_km === 100))?.[0] as Record<string, unknown>;

describe('AdminMapPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('nasce na aba Prestadores, centrado em CABA com 25 km e país AR; lista + contagens; seletor de paciente com escopo largo', () => {
    setup();
    expect(screen.getByTestId('map-tab-workers')).toHaveAttribute('aria-selected', 'true');
    expect(lastWorkersFilters()).toEqual({ country: 'AR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 25 });
    expect(lastPickerFilters()).toEqual({ country: 'AR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 100 });
    expect(screen.getByTestId('map-total')).toHaveTextContent('2');
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 25 km');
    expect(screen.getByTestId('map-without-coords')).toHaveTextContent('1 sin ubicación');
    expect(screen.queryByTestId('map-truncated')).toBeNull();
    const items = screen.getAllByTestId('map-list-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('W 1');
    expect(items[0]).toHaveTextContent('1.2 km');
    expect(items[0]).toHaveTextContent('AT · Documentación completa · Flores · CABA');
    expect(items[1]).toHaveAttribute('data-has-coords', 'false');
    expect(items[1]).toHaveTextContent('Sin profesión · Registro incompleto · sin ubicación');
    expect(screen.getByRole('link', { name: 'W 1' })).toHaveAttribute('href', '/admin/workers/1');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-points', '1,2');
    // seletor de paciente lista só quem tem coordenada
    const picker = screen.getByTestId('map-center-patient') as HTMLSelectElement;
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', 'a-9']);
    expect(picker.options[1].textContent).toBe('P 9 · CABA');
  });

  it('filtros de prestador entram no corpo da request: documentação, profissão, raio, país', () => {
    setup();
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'incomplete' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: 'CAREGIVER' } });
    fireEvent.change(screen.getByTestId('map-radius'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'BR' } });
    expect(lastWorkersFilters()).toEqual({ country: 'BR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 5, docs_complete: 'incomplete', profession: ['CAREGIVER'] });
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 5 km');
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: '' } });
    expect(lastWorkersFilters()).toEqual({ country: 'BR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 5 });
  });

  it('centrar em paciente move o centro; clique no mapa move de novo e limpa o seletor', () => {
    setup();
    fireEvent.change(screen.getByTestId('map-center-patient'), { target: { value: 'a-9' } });
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect((screen.getByTestId('map-center-patient') as HTMLSelectElement).value).toBe('a-9');
    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.7,-58.5');
    expect((screen.getByTestId('map-center-patient') as HTMLSelectElement).value).toBe('');
    expect(lastWorkersFilters()).toMatchObject({ center: { lat: -34.7, lng: -58.5 } });
    // escolher "vazio" ou um id sem coordenada não move
    fireEvent.change(screen.getByTestId('map-center-patient'), { target: { value: '' } });
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.7,-58.5');
  });

  it('aba Pacientes: filtros próprios, lista com vagas abertas, truncado sinalizado, links para a ficha', () => {
    setup();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-tab-patients')).toHaveAttribute('aria-selected', 'true');
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 25 });
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 25, status: ['SUSPENDED'], with_open_vacancies: true });
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: { lat: -34.6037, lng: -58.3816 }, radius_km: 25 });
    expect(screen.getByTestId('map-truncated')).toBeInTheDocument();
    const items = screen.getAllByTestId('map-list-item');
    expect(items[0]).toHaveTextContent('Activo · CABA · 1 vacante(s) abierta(s)');
    expect(items[0]).toHaveTextContent('0.4 km');
    expect(items[1]).toHaveTextContent('Activo · sin ubicación');
    expect(items[1]).not.toHaveTextContent('vacante');
    expect(screen.getByRole('link', { name: 'P 9' })).toHaveAttribute('href', '/admin/patients/9');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-points', 'a-9,8');
    // nada clínico na tela
    expect(document.body.textContent).not.toMatch(/diagn/i);
  });

  it('seleção: clique na lista e no pino destacam o mesmo id; trocar de aba limpa', () => {
    setup();
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '1');
    expect(screen.getAllByTestId('map-list-item')[0].className).toContain('bg-blue-50');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
    fireEvent.click(screen.getByTestId('fake-map-select'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', 'a-9');
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '8');
    fireEvent.click(screen.getByTestId('map-tab-workers'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
    // clicar no link não seleciona (stopPropagation)
    fireEvent.click(screen.getByRole('link', { name: 'W 2' }));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
  });

  it('estados: carregando, erro, vazio; refresh chama refetch da aba ativa', async () => {
    const refetch = vi.fn();
    setup({ ...okWorkers, isLoading: true, points: [], refetch }, okPatients);
    expect(screen.getByTestId('map-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('map-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('map-refresh'));
    expect(refetch).toHaveBeenCalledTimes(1);

    setup({ ...okWorkers, error: 'Invalid map filters' as string | null, points: [] }, okPatients);
    expect(last(screen.getAllByTestId('map-error'))).toHaveTextContent('Invalid map filters');

    setup({ ...okWorkers, points: [], total: 0, withoutCoordinates: 0 }, okPatients);
    await waitFor(() => expect(screen.getAllByTestId('map-empty').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('map-without-coords')).toHaveLength(0);
  });

  it('cor de status desconhecido cai no cinza (pino e bolinha)', () => {
    setup({ ...okWorkers, points: [W('x', { status: 'WEIRD' })] }, { ...okPatients, points: [PT('y', { status: 'WEIRD' })] });
    expect((last(mapProps.mock.calls)?.[0] as { points: Array<{ color: string }> }).points[0].color).toBe('#6b7280');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect((last(mapProps.mock.calls)?.[0] as { points: Array<{ color: string }> }).points[0].color).toBe('#6b7280');
  });
});
