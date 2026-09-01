/**
 * AdminMapPage.test.tsx — a página com os hooks e o mapa substituídos: o que
 * se afirma é a composição (abas, filtros → corpo da request, contagens,
 * lista, centro por paciente/clique, seleção).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// Os hooks recebem (filtros, enabled). A página chama usePatientsMapPoints DUAS
// vezes por render, nesta ordem: aba de pacientes e depois o seletor "centrar en paciente".
const mockWorkers = vi.fn<[unknown, boolean], unknown>();
const mockPatients = vi.fn<[unknown, boolean], unknown>();
vi.mock('@hooks/admin/useMapPoints', () => ({
  useWorkersMapPoints: (f: unknown, enabled: boolean) => mockWorkers(f, enabled),
  usePatientsMapPoints: (f: unknown, enabled: boolean) => mockPatients(f, enabled),
}));

// O mapa vira um botão que simula o clique do usuário e um marcador do selecionado
const mapProps = vi.fn<[unknown], void>();
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (props: { points: Array<{ id: string; title: string }>; center: { lat: number; lng: number }; radiusKm: number; onCenterChange: (c: { lat: number; lng: number }) => void; selectedId: string | null; onSelect: (id: string | null) => void; hoveredId: string | null; onHover: (id: string | null) => void }) => {
    mapProps(props);
    return (
      <div data-testid="fake-map" data-center={`${props.center.lat},${props.center.lng}`} data-radius={props.radiusKm} data-selected={props.selectedId ?? ''} data-hovered={props.hoveredId ?? ''} data-points={props.points.map((p) => p.id).join(',')}>
        <button data-testid="fake-map-click" onClick={() => props.onCenterChange({ lat: -34.7, lng: -58.5 })}>click</button>
        <button data-testid="fake-map-select" onClick={() => props.onSelect(props.points[0]?.id ?? null)}>select</button>
        <button data-testid="fake-map-hover" onClick={() => props.onHover(props.points[1]?.id ?? null)}>hover</button>
      </div>
    );
  },
}));

const W = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `W ${id}`, lat: -34.6, lng: -58.4, status: 'REGISTERED', documentsComplete: true, profession: 'AT', city: 'CABA', neighborhood: 'Flores', state: 'BA', distanceKm: 1.2, ...over });
const PT = (id: string, over: Record<string, unknown> = {}) => ({ id, addressId: `a-${id}`, name: `P ${id}`, lat: -34.61, lng: -58.41, status: 'ACTIVE', addressType: 'primary', city: 'CABA', neighborhood: null, state: 'BA', openVacancies: 1, distanceKm: 0.4, ...over });

// W3: tem coordenada mas nenhum lugar (cidade/bairro nulos) — a linha não pode dizer "sin ubicación".
const okWorkers: { points: ReturnType<typeof W>[]; total: number; withoutCoordinates: number; truncated: boolean; isLoading: boolean; error: string | null; refetch: () => void } = { points: [W('1'), W('2', { status: 'INCOMPLETE_REGISTER', lat: null, lng: null, city: null, neighborhood: null, distanceKm: null, profession: null }), W('3', { city: null, neighborhood: null, distanceKm: null })], total: 3, withoutCoordinates: 1, truncated: false, isLoading: false, error: null, refetch: vi.fn() };
// P8: sem endereço. P7: coordenada sem lugar. P6: lat sem lng (coordenada INCOMPLETA — não serve de centro). P5: coordenada sem addressId (id cai no do paciente).
// `total` é o do BANCO (COUNT(*) OVER()) e `points` é o que o teto de 500 deixou passar: 5 na tela, 4231 no filtro → truncado.
const okPatients: { points: ReturnType<typeof PT>[]; total: number; withoutCoordinates: number; truncated: boolean; isLoading: boolean; error: string | null; refetch: () => void } = { points: [PT('9'), PT('8', { addressId: null, lat: null, lng: null, city: null, openVacancies: 0, distanceKm: null }), PT('7', { city: null, neighborhood: null, openVacancies: 0 }), PT('6', { lng: null, openVacancies: 0 }), PT('5', { addressId: null, openVacancies: 0 })], total: 4231, withoutCoordinates: 1, truncated: true, isLoading: false, error: null, refetch: vi.fn() };

function setup(workers = okWorkers, patients = okPatients) {
  mockWorkers.mockReturnValue(workers);
  mockPatients.mockReturnValue(patients);
  return render(<MemoryRouter><AdminMapPage /></MemoryRouter>);
}

const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
const lastWorkersCall = () => last(mockWorkers.mock.calls) as [Record<string, unknown>, boolean];
const lastWorkersFilters = () => lastWorkersCall()[0];
/** Penúltima chamada = aba de pacientes; última = seletor. */
const lastPatientsCall = () => mockPatients.mock.calls[mockPatients.mock.calls.length - 2] as [Record<string, unknown>, boolean];
const lastPickerCall = () => last(mockPatients.mock.calls) as [Record<string, unknown>, boolean];
const lastPatientsFilters = () => lastPatientsCall()[0];
const lastPickerFilters = () => lastPickerCall()[0];
const CABA = { lat: -34.6037, lng: -58.3816 };
const SAO_PAULO = { lat: -23.5505, lng: -46.6333 };

/** O seletor de paciente é um combobox com busca, não um `<select>`: abrir e clicar. */
function openPicker(): HTMLElement {
  const picker = screen.getByTestId('map-center-patient');
  fireEvent.click(within(picker).getByRole('button'));
  return picker;
}
function pickerOptions(): string[] {
  return within(openPicker()).getAllByRole('option').map((o) => o.textContent ?? '');
}
function pickPatient(label: string): void {
  const picker = openPicker();
  // pelo ROLE, não pelo texto: com a lista aberta o rótulo do botão repete o placeholder
  const option = within(picker).getAllByRole('option').find((o) => o.textContent === label);
  if (!option) throw new Error(`opção "${label}" não está na lista`);
  fireEvent.click(option);
}
function pickerLabel(): string {
  return within(screen.getByTestId('map-center-patient')).getByRole('button').textContent ?? '';
}

describe('AdminMapPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('nasce na aba Prestadores, centrado em CABA com 25 km e país AR; só a aba ativa busca; lista + contagens', () => {
    setup();
    expect(screen.getByTestId('map-tab-workers')).toHaveAttribute('aria-selected', 'true');
    expect(lastWorkersCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 25 }, true]);
    // a aba de pacientes e o seletor NÃO buscam: enabled=false
    expect(lastPatientsCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 25 }, false]);
    expect(lastPickerCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 25 }, false]);
    expect(mockPatients.mock.calls.every((c) => c[1] === false)).toBe(true);
    expect(screen.getByTestId('map-total')).toHaveTextContent('3');
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 25 km');
    expect(screen.getByTestId('map-without-coords')).toHaveTextContent('1 sin ubicación');
    expect(screen.queryByTestId('map-truncated')).toBeNull();
    const items = screen.getAllByTestId('map-list-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('W 1');
    expect(items[0]).toHaveTextContent('1.2 km');
    expect(items[0]).toHaveTextContent('AT · Documentación completa · Flores · CABA');
    expect(items[1]).toHaveAttribute('data-has-coords', 'false');
    expect(items[1]).toHaveTextContent('Sin profesión · Registro incompleto · sin ubicación');
    // coordenada sem cidade/bairro: nem lugar nem "sin ubicación"
    expect(items[2]).toHaveAttribute('data-has-coords', 'true');
    expect(items[2]).toHaveTextContent('AT · Documentación completa');
    expect(items[2]).not.toHaveTextContent('sin ubicación');
    expect(screen.getByRole('link', { name: 'W 1' })).toHaveAttribute('href', '/admin/workers/1');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-points', '1,2,3');
  });

  it('seletor de paciente: só busca depois de tocado, com o centro e o raio ATUAIS do mapa; lista só quem tem lat E lng', () => {
    setup();
    fireEvent.change(screen.getByTestId('map-radius'), { target: { value: '10' } });
    expect(lastPickerCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 10 }, false]);
    // pelo TECLADO: focar o seletor já dispara a busca preguiçosa (não só o clique)
    fireEvent.focusIn(screen.getByTestId('map-center-patient'));
    expect(lastPickerCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 10 }, true]);
    openPicker();
    // a aba de pacientes continua parada
    expect(lastPatientsCall()[1]).toBe(false);
    // mover o centro (clique no mapa) move também o escopo do seletor
    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(lastPickerFilters()).toEqual({ country: 'AR', center: { lat: -34.7, lng: -58.5 }, radius_km: 10 });
    // P8 (sem endereço) e P6 (lat sem lng) ficam fora; P7 sem lugar mostra só o nome
    expect(pickerOptions()).toEqual(['Centrar en un paciente…', 'P 9 · CABA', 'P 7', 'P 5 · CABA']);
  });

  it('trocar o país move o centro para o padrão do país (BR nasce em São Paulo) e limpa o paciente escolhido', () => {
    setup();
    pickPatient('P 9 · CABA');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'BR' } });
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', `${SAO_PAULO.lat},${SAO_PAULO.lng}`);
    expect(lastWorkersFilters()).toEqual({ country: 'BR', center: SAO_PAULO, radius_km: 25 });
    expect(lastPickerFilters()).toEqual({ country: 'BR', center: SAO_PAULO, radius_km: 25 });
    expect(pickerLabel()).toContain('Centrar en un paciente…');
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'AR' } });
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', `${CABA.lat},${CABA.lng}`);
  });

  it('filtros de prestador entram no corpo da request: documentação, profissão, raio, país', () => {
    setup();
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'incomplete' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: 'CAREGIVER' } });
    fireEvent.change(screen.getByTestId('map-radius'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'BR' } });
    expect(lastWorkersFilters()).toEqual({ country: 'BR', center: SAO_PAULO, radius_km: 5, docs_complete: 'incomplete', profession: ['CAREGIVER'] });
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 5 km');
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: '' } });
    expect(lastWorkersFilters()).toEqual({ country: 'BR', center: SAO_PAULO, radius_km: 5 });
  });

  it('centrar em paciente move o centro; clique no mapa move de novo e limpa o seletor', () => {
    setup();
    pickPatient('P 9 · CABA');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect(pickerLabel()).toContain('P 9 · CABA');
    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.7,-58.5');
    expect(pickerLabel()).toContain('Centrar en un paciente…');
    expect(lastWorkersFilters()).toMatchObject({ center: { lat: -34.7, lng: -58.5 } });
    // escolher "vazio" ou um id sem coordenada não move
    pickPatient('Centrar en un paciente…');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.7,-58.5');
  });

  it('aba Pacientes: filtros próprios, lista com vagas abertas, truncado sinalizado, links para a ficha', () => {
    setup();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-tab-patients')).toHaveAttribute('aria-selected', 'true');
    // agora é a aba de pacientes que busca; prestadores e seletor param
    expect(lastPatientsCall()).toEqual([{ country: 'AR', center: CABA, radius_km: 25 }, true]);
    expect(lastWorkersCall()[1]).toBe(false);
    expect(lastPickerCall()[1]).toBe(false);
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: CABA, radius_km: 25, status: ['SUSPENDED'], with_open_vacancies: true });
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: CABA, radius_km: 25 });
    // Truncado: a contagem é a do banco (4231), e o aviso diz quantos está mostrando de quantos existem.
    expect(screen.getByTestId('map-total')).toHaveTextContent('4231');
    expect(screen.getByTestId('map-truncated')).toHaveTextContent('mostrando los primeros 5 de 4231 — achicá el radio');
    const items = screen.getAllByTestId('map-list-item');
    expect(items[0]).toHaveTextContent('Activo · CABA · 1 vacante(s) abierta(s)');
    expect(items[0]).toHaveTextContent('0.4 km');
    expect(items[1]).toHaveTextContent('Activo · sin ubicación');
    expect(items[1]).not.toHaveTextContent('vacante');
    // coordenada sem lugar: só o status
    expect(items[2]).toHaveTextContent('Activo');
    expect(items[2]).not.toHaveTextContent('sin ubicación');
    // a linha, o pino e a seleção usam o MESMO id (o do endereço); o id do paciente vai em data-patient-id
    expect(items[0]).toHaveAttribute('data-point-id', 'a-9');
    expect(items[0]).toHaveAttribute('data-patient-id', '9');
    expect(items[1]).toHaveAttribute('data-point-id', '8');
    expect(screen.getByRole('link', { name: 'P 9' })).toHaveAttribute('href', '/admin/patients/9');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-points', 'a-9,8,a-7,a-6,5');
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
    // clicar no NOME (link) abre a ficha sem selecionar a linha — nas duas abas
    fireEvent.click(screen.getByRole('link', { name: 'P 7' }));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '8');
    fireEvent.click(screen.getByTestId('map-tab-workers'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
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

  it('o centro tem identidade legível e volta atrás: clicar no mapa não apaga o paciente de referência', () => {
    setup();
    // nasce no ponto inicial do país: nada para desfazer
    expect(screen.getByTestId('map-center-label')).toHaveTextContent('Centro: punto inicial');
    expect(screen.queryByTestId('map-center-back')).toBeNull();

    pickPatient('P 9 · CABA');
    expect(screen.getByTestId('map-center-label')).toHaveTextContent('Centro: P 9');
    expect(screen.queryByTestId('map-center-back')).toBeNull();

    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(screen.getByTestId('map-center-label')).toHaveTextContent('Centro: punto marcado en el mapa');
    fireEvent.click(screen.getByTestId('map-center-back'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect(pickerLabel()).toContain('P 9 · CABA');

    // sem paciente de referência, o "voltar" leva ao ponto inicial do país
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'BR' } });
    fireEvent.click(screen.getByTestId('fake-map-click'));
    fireEvent.click(screen.getByTestId('map-center-back'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', `${SAO_PAULO.lat},${SAO_PAULO.lng}`);
  });

  it('destaque nos dois sentidos: cursor na linha acende o pino, e o pino acende a linha', () => {
    setup();
    const items = screen.getAllByTestId('map-list-item');
    fireEvent.mouseEnter(items[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '1');
    expect(items[0].className).toContain('bg-gray-100');
    fireEvent.mouseLeave(screen.getByTestId('map-list'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '');
    // do mapa para a lista
    fireEvent.click(screen.getByTestId('fake-map-hover'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '2');
    expect(screen.getAllByTestId('map-list-item')[1].className).toContain('bg-gray-100');
    // e vale na aba de pacientes, onde a linha é identificada pelo endereço
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    fireEvent.mouseEnter(screen.getAllByTestId('map-list-item')[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', 'a-9');
  });

  it('escolher quem não tem coordenada avisa em vez de não fazer nada', () => {
    setup();
    expect(screen.queryByTestId('map-selected-no-location')).toBeNull();
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]); // W 2, lat null
    expect(screen.getByTestId('map-selected-no-location')).toHaveTextContent('W 2 no tiene ubicación registrada');
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]); // W 1 tem coordenada
    expect(screen.queryByTestId('map-selected-no-location')).toBeNull();
  });

  it('a legenda mostra uma bolinha por cor da aba ativa', () => {
    setup();
    expect(screen.getByTestId('map-legend')).toHaveTextContent('Documentación completa');
    expect(screen.getByTestId('map-legend')).toHaveTextContent('Dado de baja');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-legend')).toHaveTextContent('En admisión / Esperando financiero');
  });
});
