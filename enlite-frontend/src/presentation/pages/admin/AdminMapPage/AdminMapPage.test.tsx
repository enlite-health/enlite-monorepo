/**
 * AdminMapPage.test.tsx — a página com os hooks e o mapa substituídos: o que
 * se afirma é a composição (abas, PORTÃO da âncora, filtros → corpo da
 * request, contagens, lista, centro, seleção).
 *
 * O portão é o eixo do arquivo: sem âncora escolhida, NADA busca e os passos 2
 * e 3 não existem. Por isso quase todo teste começa por `escolherAncora()`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// Cada hook é chamado DUAS vezes por render: [0] a aba, [1] o seletor da âncora.
const mockWorkers = vi.fn<[unknown, boolean], unknown>();
const mockPatients = vi.fn<[unknown, boolean], unknown>();
vi.mock('@hooks/admin/useMapPoints', () => ({
  useWorkersMapPoints: (f: unknown, enabled: boolean) => mockWorkers(f, enabled),
  usePatientsMapPoints: (f: unknown, enabled: boolean) => mockPatients(f, enabled),
}));

// O mapa vira um botão que simula o clique do usuário e um marcador do selecionado
const mapProps = vi.fn<[unknown], void>();
const mockCorridor = vi.fn();
vi.mock('@hooks/admin/useCorridor', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCorridor: (pair: unknown) => mockCorridor(pair) ?? { data: null, isLoading: false, error: null },
}));

vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (props: { points: Array<{ id: string; title: string; lat: number | null; lng: number | null }>; center: { lat: number; lng: number }; radiusKm: number; onCenterChange: (c: { lat: number; lng: number }) => void; selectedId: string | null; onSelect: (id: string | null) => void; hoveredId: string | null; onHover: (id: string | null) => void; onCenterHere: (p: { id: string; lat: number | null; lng: number | null }) => void; renderExtra?: (p: { id: string; lat: number | null }) => unknown }) => {
    mapProps(props);
    return (
      <div data-testid="fake-map" data-center={`${props.center.lat},${props.center.lng}`} data-radius={props.radiusKm} data-selected={props.selectedId ?? ''} data-hovered={props.hoveredId ?? ''} data-points={props.points.map((p) => p.id).join(',')}>
        <button data-testid="fake-map-click" onClick={() => props.onCenterChange({ lat: -34.7, lng: -58.5 })}>click</button>
        <button data-testid="fake-map-select" onClick={() => props.onSelect(props.points[0]?.id ?? null)}>select</button>
        <button data-testid="fake-map-hover" onClick={() => props.onHover(props.points[1]?.id ?? null)}>hover</button>
        <button data-testid="fake-map-center-here" onClick={() => props.onCenterHere(props.points[0] as never)}>centrar aqui</button>
        <button data-testid="fake-map-center-here-sem-coord" onClick={() => props.onCenterHere({ id: 'z', lat: null, lng: null })}>sem coord</button>
        {/* o slot do balão: é por aqui que o corredor entra na tela */}
        <div data-testid="fake-map-extra">{(() => {
          const alvo = props.points.find((x) => x.id === props.selectedId) ?? props.points[0];
          return alvo ? (props.renderExtra?.(alvo) as never) : null;
        })()}</div>
      </div>
    );
  },
}));

const W = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `W ${id}`, lat: -34.6, lng: -58.4, status: 'REGISTERED', documentsComplete: true, profession: 'AT', city: 'CABA', neighborhood: 'Flores', state: 'BA', distanceKm: 1.2, ...over });
const PT = (id: string, over: Record<string, unknown> = {}) => ({ id, addressId: `a-${id}`, name: `P ${id}`, lat: -34.61, lng: -58.41, status: 'ACTIVE', city: 'CABA', neighborhood: null, state: 'BA', openVacancies: 1, distanceKm: 0.4, ...over });

type Res<P> = { points: P[]; total: number; withoutCoordinates: number; truncated: boolean; isLoading: boolean; error: string | null; refetch: () => void };

// W3: tem coordenada mas nenhum lugar (cidade/bairro nulos) — a linha não pode dizer "sin ubicación".
const okWorkers: Res<ReturnType<typeof W>> = { points: [W('1'), W('2', { status: 'INCOMPLETE_REGISTER', lat: null, lng: null, city: null, neighborhood: null, distanceKm: null, profession: null }), W('3', { city: null, neighborhood: null, distanceKm: null })], total: 3, withoutCoordinates: 1, truncated: false, isLoading: false, error: null, refetch: vi.fn() };
// P8: sem endereço. P7: coordenada sem lugar. P6: lat sem lng (coordenada INCOMPLETA — não serve de âncora). P5: coordenada sem addressId (id cai no do paciente).
// `total` é o do BANCO (COUNT(*) OVER()) e `points` é o que o teto de 500 deixou passar: 5 na tela, 4231 no filtro → truncado.
const okPatients: Res<ReturnType<typeof PT>> = { points: [PT('9'), PT('8', { addressId: null, lat: null, lng: null, city: null, openVacancies: 0, distanceKm: null }), PT('7', { city: null, neighborhood: null, openVacancies: 0 }), PT('6', { lng: null, openVacancies: 0 }), PT('5', { addressId: null, openVacancies: 0 })], total: 4231, withoutCoordinates: 1, truncated: true, isLoading: false, error: null, refetch: vi.fn() };

function setup(workers = okWorkers, patients = okPatients) {
  mockWorkers.mockReturnValue(workers);
  mockPatients.mockReturnValue(patients);
  return render(<MemoryRouter><AdminMapPage /></MemoryRouter>);
}

const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
/** Do último render: [len-2] é a aba, [len-1] é o seletor da âncora. */
const tabCall = (m: typeof mockWorkers) => m.mock.calls[m.mock.calls.length - 2] as [Record<string, unknown>, boolean];
const pickerCall = (m: typeof mockWorkers) => last(m.mock.calls) as [Record<string, unknown>, boolean];
const lastWorkersCall = () => tabCall(mockWorkers);
const lastWorkersFilters = () => lastWorkersCall()[0];
const lastPatientsCall = () => tabCall(mockPatients);
const lastPatientsFilters = () => lastPatientsCall()[0];
const CABA = { lat: -34.6037, lng: -58.3816 };
const SAO_PAULO = { lat: -23.5505, lng: -46.6333 };
/** O escopo do seletor: centro do PAÍS e raio FIXO de 50 km, nunca o raio da tela. */
const ancoraAR = { country: 'AR', center: CABA, radius_km: 50 };
const ancoraBR = { country: 'BR', center: SAO_PAULO, radius_km: 50 };

/** O seletor da âncora é um combobox com busca, não um `<select>`: abrir e clicar. */
function openPicker(id = 'map-center-patient'): HTMLElement {
  // `setup` monta uma árvore NOVA sem desmontar a anterior: sempre a última.
  const picker = last(screen.getAllByTestId(id)) as HTMLElement;
  fireEvent.click(within(picker).getByRole('button'));
  return picker;
}
function pickerOptions(id = 'map-center-patient'): string[] {
  return within(openPicker(id)).getAllByRole('option').map((o) => o.textContent ?? '');
}
function pick(label: string, id = 'map-center-patient'): void {
  const picker = openPicker(id);
  // pelo ROLE, não pelo texto: com a lista aberta o rótulo do botão repete o placeholder
  const option = within(picker).getAllByRole('option').find((o) => o.textContent === label);
  if (!option) throw new Error(`opção "${label}" não está na lista`);
  fireEvent.click(option);
}
function pickerLabel(id = 'map-center-patient'): string {
  return within(last(screen.getAllByTestId(id)) as HTMLElement).getByRole('button').textContent ?? '';
}
/** O caminho normal da tela: escolher a âncora abre o passo 2 em diante. */
const escolherPaciente = (label = 'P 9 · CABA'): void => pick(label);
const escolherPrestador = (label = 'W 1 · Flores · CABA'): void => pick(label, 'map-center-worker');

describe('AdminMapPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('PORTÃO fechado: abrir a página não busca NADA, e o passo 2 em diante não existe', () => {
    setup();
    expect(screen.getByTestId('map-tab-workers')).toHaveAttribute('aria-selected', 'true');
    // nenhum dos quatro hooks está habilitado — abrir a tela custa zero request
    expect(mockWorkers.mock.calls.every((c) => c[1] === false)).toBe(true);
    expect(mockPatients.mock.calls.every((c) => c[1] === false)).toBe(true);
    // passo 1 está lá (país + seletor); 2 e 3 não
    expect(screen.getByTestId('map-center-block')).toBeInTheDocument();
    expect(screen.getByTestId('map-center-patient')).toBeInTheDocument();
    expect(screen.queryByTestId('map-filters-block')).toBeNull();
    expect(screen.queryByTestId('map-radius')).toBeNull();
    expect(screen.queryByTestId('map-counts')).toBeNull();
    expect(screen.queryByTestId('map-list')).toBeNull();
    expect(screen.queryByTestId('map-refresh')).toBeNull();
    // e no lugar do mapa, o convite — não um retângulo cinza que parece falha
    expect(screen.queryByTestId('fake-map')).toBeNull();
    expect(screen.getByTestId('map-anchor-empty')).toHaveTextContent('Elegí un paciente para empezar');
  });

  it('escolher o paciente ABRE o passo 2 em diante, centra nele e a busca nasce em 5 km', () => {
    setup();
    escolherPaciente();
    // centro = o domicílio do paciente escolhido; raio default 5 km (Marcel, 02/09)
    expect(lastWorkersCall()).toEqual([{ country: 'AR', center: { lat: -34.61, lng: -58.41 }, radius_km: 5 }, true]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-radius', '5');
    expect(screen.getByTestId('map-radius')).toHaveValue('5');
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 5 km');
    // a aba de pacientes continua parada — o portão dela é outro
    expect(lastPatientsCall()[1]).toBe(false);
    expect(screen.getByTestId('map-filters-block')).toBeInTheDocument();
    expect(screen.queryByTestId('map-anchor-empty')).toBeNull();
    // a lista
    const items = screen.getAllByTestId('map-list-item');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('W 1');
    expect(items[0]).toHaveTextContent('1.2 km');
    expect(items[0]).toHaveTextContent('AT · Documentación completa · Flores · CABA');
    expect(items[1]).toHaveAttribute('data-has-coords', 'false');
    expect(items[1]).toHaveTextContent('Sin profesión · Registro incompleto · sin ubicación');
    // coordenada sem cidade/bairro: nem lugar nem "sin ubicación"
    expect(items[2]).toHaveAttribute('data-has-coords', 'true');
    expect(items[2]).not.toHaveTextContent('sin ubicación');
    expect(screen.getByRole('link', { name: 'W 1' })).toHaveAttribute('href', '/admin/workers/1');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-points', '1,2,3');
    expect(screen.getByTestId('map-total')).toHaveTextContent('3');
    expect(screen.getByTestId('map-without-coords')).toHaveTextContent('1 sin ubicación');
  });

  it('o seletor da âncora só busca depois de tocado, com escopo FIXO (país + 50 km) e só quem tem lat E lng', () => {
    setup();
    expect(pickerCall(mockPatients)).toEqual([ancoraAR, false]);
    // pelo TECLADO: focar o seletor já dispara a busca preguiçosa (não só o clique)
    fireEvent.focusIn(screen.getByTestId('map-center-patient'));
    expect(pickerCall(mockPatients)).toEqual([ancoraAR, true]);
    // P8 (sem endereço) e P6 (lat sem lng) ficam fora; P7 sem lugar mostra só o nome
    expect(pickerOptions()).toEqual(['Centrar en un paciente…', 'P 9 · CABA', 'P 7', 'P 5 · CABA']);
    // mudar o raio da TELA não mexe no escopo do seletor: 5 km não pode esvaziá-lo
    escolherPaciente();
    fireEvent.change(screen.getByTestId('map-radius'), { target: { value: '50' } });
    expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
  });

  it('a opção VAZIA LIMPA a âncora e fecha o portão; paciente sem addressId ancora pelo id da pessoa', () => {
    setup();
    fireEvent.focusIn(screen.getByTestId('map-center-patient'));
    // antes de escolher, a opção vazia mantém o portão fechado
    pick('Centrar en un paciente…');
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
    expect(tabCall(mockWorkers)[1]).toBe(false);

    // com âncora ativa, a mesma opção DESFAZ a escolha — não é um controle morto
    escolherPaciente();
    expect(screen.getByTestId('map-filters-block')).toBeInTheDocument();
    pick('Centrar en un paciente…');
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('map-filters-block')).toBeNull();
    expect(tabCall(mockWorkers)[1]).toBe(false);
    expect(screen.queryByTestId('fake-map')).toBeNull();

    // P5 não tem addressId: o id do ponto cai no id do PACIENTE
    escolherPaciente('P 5 · CABA');
    expect(screen.getByTestId('map-filters-block')).toBeInTheDocument();
    expect(pickerLabel()).toContain('P 5 · CABA');

    // e o mesmo do lado dos prestadores
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    fireEvent.focusIn(screen.getByTestId('map-center-worker'));
    pick('Centrar en un prestador…', 'map-center-worker');
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
    expect(tabCall(mockPatients)[1]).toBe(false);
  });

  it('C-R5 (lex): o rótulo da opção é nome · lugar — nunca estado nem nada clínico', () => {
    setup();
    fireEvent.focusIn(screen.getByTestId('map-center-patient'));
    const rotulos = pickerOptions().slice(1);
    expect(rotulos).toEqual(['P 9 · CABA', 'P 7', 'P 5 · CABA']);
    for (const r of rotulos) {
      expect(r).not.toMatch(/Activo|Suspendido|admisión|vacante|diagn/i);
    }
  });

  it('o seletor da âncora não fica mudo: diz carregando, erro e teto — ele é o único caminho para a tela', () => {
    // carregando
    setup(okWorkers, { ...okPatients, isLoading: true, points: [] });
    expect(screen.getByTestId('map-anchor-loading')).toHaveTextContent('Buscando…');
    expect(screen.queryByTestId('map-anchor-error')).toBeNull();

    // erro: sem isto, um 500 no seletor se lê como "não há nenhum paciente".
    // O erro tem precedência sobre o "carregando" na MESMA árvore — por isso a
    // busca é dentro do bloco novo, e não em `screen` (que ainda vê a anterior).
    setup(okWorkers, { ...okPatients, error: 'Invalid map filters' as string | null, points: [] });
    const comErro = last(screen.getAllByTestId('map-center-block')) as HTMLElement;
    expect(within(comErro).getByTestId('map-anchor-error')).toHaveTextContent('No se pudo cargar la lista');
    expect(within(comErro).queryByTestId('map-anchor-loading')).toBeNull();

    // teto de 500: há gente que NÃO está na lista, e a tela precisa dizer
    setup(okWorkers, { ...okPatients, truncated: true });
    expect(last(screen.getAllByTestId('map-anchor-truncated'))).toHaveTextContent('escribí el nombre para filtrar');

    // nada a dizer: nenhuma das três notas aparece na ÁRVORE NOVA
    // (`setup` monta sem desmontar as anteriores, que ainda carregam as notas)
    setup(okWorkers, { ...okPatients, truncated: false });
    const bloco = last(screen.getAllByTestId('map-center-block')) as HTMLElement;
    for (const id of ['map-anchor-loading', 'map-anchor-error', 'map-anchor-truncated']) {
      expect(within(bloco).queryByTestId(id), `${id} não deve aparecer`).toBeNull();
    }
  });

  it('o seletor da aba ATIVA é a fonte do estado — o da outra aba não vaza', () => {
    // erro só do lado dos PRESTADORES (o seletor da aba de pacientes)
    setup({ ...okWorkers, error: 'boom' as string | null, points: [] }, { ...okPatients, truncated: false });
    // na aba de prestadores quem manda é o seletor de PACIENTES: sem erro
    expect(screen.queryByTestId('map-anchor-error')).toBeNull();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-anchor-error')).toBeInTheDocument();
  });

  it('aba Pacientes tem portão PRÓPRIO, com seletor de PRESTADOR', () => {
    setup();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-tab-patients')).toHaveAttribute('aria-selected', 'true');
    // portão fechado de novo: ninguém busca, e o seletor agora é de prestador
    expect(mockPatients.mock.calls.every((c) => c[1] === false)).toBe(true);
    expect(screen.queryByTestId('map-center-patient')).toBeNull();
    expect(screen.getByTestId('map-center-worker')).toBeInTheDocument();
    expect(screen.getByTestId('map-anchor-empty')).toHaveTextContent('Elegí un prestador para empezar');
    expect(screen.queryByTestId('map-filters-block')).toBeNull();

    fireEvent.focusIn(screen.getByTestId('map-center-worker'));
    expect(pickerCall(mockWorkers)).toEqual([ancoraAR, true]);
    // W2 não tem coordenada: fica fora da lista de âncoras possíveis
    expect(pickerOptions('map-center-worker')).toEqual(['Centrar en un prestador…', 'W 1 · Flores · CABA', 'W 3']);

    escolherPrestador();
    expect(lastPatientsCall()).toEqual([{ country: 'AR', center: { lat: -34.6, lng: -58.4 }, radius_km: 5 }, true]);
    expect(lastWorkersCall()[1]).toBe(false);
  });

  it('a âncora é POR ABA: ir e voltar não apaga a do outro lado', () => {
    setup();
    escolherPaciente();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    // a aba de pacientes ainda não tem âncora — portão fechado
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
    escolherPrestador();
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.6,-58.4');
    // voltar para prestadores devolve o paciente escolhido e o centro dele
    fireEvent.click(screen.getByTestId('map-tab-workers'));
    expect(pickerLabel()).toContain('P 9 · CABA');
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect(lastWorkersCall()[1]).toBe(true);
  });

  it('trocar o país FECHA os dois portões: a âncora era do país anterior', () => {
    setup();
    escolherPaciente();
    fireEvent.change(screen.getByTestId('map-country'), { target: { value: 'BR' } });
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('map-filters-block')).toBeNull();
    expect(pickerLabel()).toContain('Centrar en un paciente…');
    // no ÚLTIMO render nada busca (`mock.calls` acumula desde o beforeEach,
    // e antes da troca de país a aba de prestadores estava ligada)
    expect(tabCall(mockWorkers)[1]).toBe(false);
    expect(pickerCall(mockPatients)[0]).toEqual(ancoraBR);
    // e a âncora da OUTRA aba também caiu
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-anchor-empty')).toBeInTheDocument();
  });

  it('filtros de prestador entram no corpo da request: documentação, profissão, raio, país', () => {
    setup();
    escolherPaciente();
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'incomplete' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: 'CAREGIVER' } });
    fireEvent.change(screen.getByTestId('map-radius'), { target: { value: '25' } });
    expect(lastWorkersFilters()).toEqual({ country: 'AR', center: { lat: -34.61, lng: -58.41 }, radius_km: 25, docs_complete: 'incomplete', profession: ['CAREGIVER'] });
    expect(screen.getByTestId('map-counts')).toHaveTextContent('en 25 km');
    fireEvent.change(screen.getByTestId('map-docs'), { target: { value: 'all' } });
    fireEvent.change(screen.getByTestId('map-profession'), { target: { value: '' } });
    expect(lastWorkersFilters()).toEqual({ country: 'AR', center: { lat: -34.61, lng: -58.41 }, radius_km: 25 });
  });

  it('aba Pacientes: filtros próprios, vagas abertas, truncado sinalizado, links para a ficha', () => {
    setup();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador();
    const centro = { lat: -34.6, lng: -58.4 };
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: 'SUSPENDED' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: centro, radius_km: 5, status: ['SUSPENDED'], with_open_vacancies: true });
    fireEvent.change(screen.getByTestId('map-patient-status'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('map-open-vacancies'));
    expect(lastPatientsFilters()).toEqual({ country: 'AR', center: centro, radius_km: 5 });
    // Truncado: a contagem é a do banco (4231), e o aviso diz quantos está mostrando de quantos existem.
    expect(screen.getByTestId('map-total')).toHaveTextContent('4231');
    expect(screen.getByTestId('map-truncated')).toHaveTextContent('mostrando los primeros 5 de 4231 — achicá el radio');
    const items = screen.getAllByTestId('map-list-item');
    expect(items[0]).toHaveTextContent('Activo · CABA · 1 vacante(s) abierta(s)');
    expect(items[0]).toHaveTextContent('0.4 km');
    expect(items[1]).toHaveTextContent('Activo · sin ubicación');
    expect(items[1]).not.toHaveTextContent('vacante');
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
    escolherPaciente();
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '1');
    expect(screen.getAllByTestId('map-list-item')[0].className).toContain('bg-blue-50');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador();
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
    fireEvent.click(screen.getByTestId('fake-map-select'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', 'a-9');
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '8');
    // clicar no NOME (link) abre a ficha sem selecionar a linha
    fireEvent.click(screen.getByRole('link', { name: 'P 7' }));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '8');
    fireEvent.click(screen.getByTestId('map-tab-workers'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-selected', '');
  });

  it('estados: carregando, erro, vazio; refresh chama refetch da aba ativa', async () => {
    const refetch = vi.fn();
    setup({ ...okWorkers, isLoading: true, points: [], refetch }, okPatients);
    escolherPaciente();
    expect(screen.getByTestId('map-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('map-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('map-refresh'));
    expect(refetch).toHaveBeenCalledTimes(1);

    setup({ ...okWorkers, error: 'Invalid map filters' as string | null, points: [] }, okPatients);
    escolherPaciente();
    expect(last(screen.getAllByTestId('map-error'))).toHaveTextContent('Invalid map filters');

    setup({ ...okWorkers, points: [], total: 0, withoutCoordinates: 0 }, okPatients);
    escolherPaciente();
    await waitFor(() => expect(screen.getAllByTestId('map-empty').length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('map-without-coords')).toHaveLength(0);
  });

  it('cor de status desconhecido cai no cinza (pino e bolinha)', () => {
    setup({ ...okWorkers, points: [W('x', { status: 'WEIRD' })] }, { ...okPatients, points: [PT('y', { status: 'WEIRD' })] });
    escolherPaciente('P y · CABA');
    expect((last(mapProps.mock.calls)?.[0] as { points: Array<{ color: string }> }).points[0].color).toBe('#6b7280');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador('W x · Flores · CABA');
    expect((last(mapProps.mock.calls)?.[0] as { points: Array<{ color: string }> }).points[0].color).toBe('#6b7280');
  });

  it('clicar no mapa move o centro mas NÃO solta a âncora — ela é a referência de volta', () => {
    setup();
    escolherPaciente();
    expect(screen.getByTestId('map-center-label')).toHaveTextContent('Centro: P 9');
    expect(screen.queryByTestId('map-center-back')).toBeNull();

    fireEvent.click(screen.getByTestId('fake-map-click'));
    expect(screen.getByTestId('map-center-label')).toHaveTextContent('Centro: punto marcado en el mapa');
    expect(lastWorkersFilters()).toMatchObject({ center: { lat: -34.7, lng: -58.5 } });
    // o seletor CONTINUA mostrando o paciente: soltá-lo fecharia o portão e apagaria a tela
    expect(pickerLabel()).toContain('P 9 · CABA');
    expect(screen.getByTestId('map-filters-block')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('map-center-back'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.61,-58.41');
    expect(screen.queryByTestId('map-center-back')).toBeNull();
  });

  it('destaque nos dois sentidos: cursor na linha acende o pino, e o pino acende a linha', () => {
    setup();
    escolherPaciente();
    const items = screen.getAllByTestId('map-list-item');
    fireEvent.mouseEnter(items[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '1');
    expect(items[0].className).toContain('bg-gray-100');
    fireEvent.mouseLeave(screen.getByTestId('map-list'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '');
    fireEvent.click(screen.getByTestId('fake-map-hover'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', '2');
    expect(screen.getAllByTestId('map-list-item')[1].className).toContain('bg-gray-100');
    // e vale na aba de pacientes, onde a linha é identificada pelo endereço
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador();
    fireEvent.mouseEnter(screen.getAllByTestId('map-list-item')[0]);
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-hovered', 'a-9');
  });

  it('escolher quem não tem coordenada avisa em vez de não fazer nada', () => {
    setup();
    escolherPaciente();
    expect(screen.queryByTestId('map-selected-no-location')).toBeNull();
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]); // W 2, lat null
    expect(screen.getByTestId('map-selected-no-location')).toHaveTextContent('W 2 no tiene ubicación registrada');
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]); // W 1 tem coordenada
    expect(screen.queryByTestId('map-selected-no-location')).toBeNull();
  });

  it('a legenda mostra uma bolinha por cor da aba ativa', () => {
    setup();
    escolherPaciente();
    expect(screen.getByTestId('map-legend')).toHaveTextContent('Documentación completa');
    expect(screen.getByTestId('map-legend')).toHaveTextContent('Dado de baja');
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador();
    expect(screen.getByTestId('map-legend')).toHaveTextContent('En admisión / Esperando financiero');
  });

  it('o corredor só é consultado para o pino ABERTO, e some quando nada está selecionado', () => {
    mockCorridor.mockReturnValue({
      data: { outcome: 'ok', straightLineMeters: 1167, routes: [{ totalMinutes: 34, transfers: 0, lines: ['8'], legs: [{ kind: 'transit', minutes: 34, line: '8', mode: 'bus', from: 'a', to: 'b' }] }] },
      isLoading: false, error: null,
    });
    setup();
    escolherPaciente();
    // nada aberto: o painel nem monta, então NENHUMA chamada é feita — clicar em
    // 40 pinos custa 40 chamadas, nunca as 500 da lista inteira. Zero chamadas é
    // mais forte que "chamada com null": sem balão não há nem hook.
    expect(mockCorridor).not.toHaveBeenCalled();
    expect(screen.queryByTestId('corridor-panel')).toBeNull();

    // abrindo um pino: o par é (prestador do pino, endereço do paciente-âncora)
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]);
    expect(last(mockCorridor.mock.calls)?.[0]).toEqual({ country: 'AR', workerId: '1', patientAddressId: 'a-9' });
    expect(screen.getByTestId('corridor-panel')).toHaveTextContent('min puerta a puerta');

    // quem não tem coordenada não gera par: o painel desmonta e some da tela
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]);
    expect(screen.queryByTestId('corridor-panel')).toBeNull();
  });

  it('na aba de Pacientes o par se INVERTE: a âncora é o prestador que viaja', () => {
    mockCorridor.mockReturnValue({ data: null, isLoading: true, error: null });
    setup();
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    escolherPrestador();
    fireEvent.click(screen.getAllByTestId('map-list-item')[0]);
    expect(last(mockCorridor.mock.calls)?.[0]).toEqual({ country: 'AR', workerId: '1', patientAddressId: 'a-9' });
  });

  it('C-R1 (lex): nome e estado não vão para a gravação de sessão — as superfícies levam data-clarity-mask', () => {
    setup();
    // o seletor da âncora, ANTES de qualquer escolha: as opções são "nome · bairro"
    expect(screen.getByTestId('map-center-patient')).toHaveAttribute('data-clarity-mask', 'True');
    escolherPaciente();
    // a lista (nome + estado + bairro de cada pessoa)
    expect(screen.getByTestId('map-list')).toHaveAttribute('data-clarity-mask', 'True');
    // o rótulo do centro, que exibe o NOME do paciente-âncora
    expect(screen.getByTestId('map-center-label')).toHaveAttribute('data-clarity-mask', 'True');
    // o mapa: cobre o balão e o `title` dos marcadores, que são DOM do Google
    expect(screen.getByTestId('fake-map').closest('[data-clarity-mask="True"]')).not.toBeNull();
    // o aviso de quem não tem coordenada herda a máscara do mesmo wrapper
    fireEvent.click(screen.getAllByTestId('map-list-item')[1]);
    expect(screen.getByTestId('map-selected-no-location').closest('[data-clarity-mask="True"]')).not.toBeNull();
    // e o seletor de PRESTADOR, na outra aba
    fireEvent.click(screen.getByTestId('map-tab-patients'));
    expect(screen.getByTestId('map-center-worker')).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('"centrar aqui" do balão move o centro; ponto sem coordenada não move nada', () => {
    setup();
    escolherPaciente();
    fireEvent.click(screen.getByTestId('fake-map-center-here'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.6,-58.4');
    expect(lastWorkersFilters()).toMatchObject({ center: { lat: -34.6, lng: -58.4 } });
    // guarda: sem coordenada não há para onde ir
    fireEvent.click(screen.getByTestId('fake-map-center-here-sem-coord'));
    expect(screen.getByTestId('fake-map')).toHaveAttribute('data-center', '-34.6,-58.4');
  });

  it('enquanto uma busca NOVA está em voo, a lista diz que está buscando — na primeira carga, não', () => {
    // `setup` monta uma árvore NOVA sem desmontar a anterior: sempre olhar a última.
    const ultimaLista = () => last(screen.getAllByTestId('map-list')) as HTMLElement;

    // primeira carga: sem resultado ainda, quem fala é o "Cargando…" do contador
    setup({ ...okWorkers, isLoading: true, points: [] }, okPatients);
    escolherPaciente();
    expect(screen.getByTestId('map-loading')).toBeInTheDocument();
    expect(screen.queryAllByTestId('map-list-searching')).toHaveLength(0);

    // busca nova com resultado antigo na tela: a lista inteira é marcada
    setup({ ...okWorkers, isLoading: true }, okPatients);
    escolherPaciente();
    expect(last(screen.getAllByTestId('map-list-searching'))).toHaveTextContent('Buscando…');
    expect(ultimaLista().className).toContain('opacity-40');

    // busca terminada: some, e a lista volta ao normal
    setup(okWorkers, okPatients);
    escolherPaciente();
    expect(screen.getAllByTestId('map-list-searching')).toHaveLength(1);
    expect(ultimaLista().className).not.toContain('opacity-40');
  });

});

/**
 * Busca por NOME no seletor da âncora (07/09/2026).
 *
 * O defeito que isto fecha: o seletor trazia UMA lista — 50 km do centro do
 * país — e a caixa de texto filtrava essa lista em memória. Paciente de Mar
 * del Plata (381 km) não estava nela, e digitar o nome dizia "Sin resultados".
 * O que se afirma aqui é que digitar TROCA O ESCOPO da chamada: some o
 * centro+raio, entra `search`.
 */
describe('AdminMapPage — busca de âncora por nome', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /** Digita no campo de busca do combobox aberto e vence o debounce. */
  function digitar(texto: string, id = 'map-center-patient'): void {
    const picker = openPicker(id);
    const input = within(picker).getByRole('textbox');
    fireEvent.change(input, { target: { value: texto } });
    act(() => { vi.advanceTimersByTime(400); });
  }

  it('🔒 DOIS caracteres não buscam mais — `an` devolvia 38% da base (lex C-B)', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('an');
      expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
      expect(pickerCall(mockPatients)[0]).not.toHaveProperty('search');
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔒 digitar ≥3 letras troca o escopo: sai centro+raio, entra `search`', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('Reyna');
      const [filtros] = pickerCall(mockPatients);
      expect(filtros).toEqual({ country: 'AR', search: 'Reyna' });
      expect(filtros).not.toHaveProperty('center');
      expect(filtros).not.toHaveProperty('radius_km');
    } finally {
      vi.useRealTimers();
    }
  });

  it('1 letra NÃO busca: o escopo segue o raio de 50 km', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('R');
      expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('apagar o texto devolve o escopo geográfico', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('Reyna');
      expect(pickerCall(mockPatients)[0]).toEqual({ country: 'AR', search: 'Reyna' });
      digitar('');
      expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('NÃO filtra em memória: a lista do servidor aparece inteira', () => {
    vi.useFakeTimers();
    try {
      // o servidor respondeu "P 9", que não contém o texto digitado — antes o
      // filtro local escondia essa linha e a tela dizia "Sin resultados".
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('Reyna');
      expect(pickerOptions()).toContain('P 9 · CABA');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lista vazia com busca ativa diz que a BUSCA não achou, não que a lista está vazia', () => {
    vi.useFakeTimers();
    try {
      // achou ZERO — nem plotável nem sem-coordenada; é a busca que não casou
      setup(okWorkers, { ...okPatients, points: [], total: 0, withoutCoordinates: 0, truncated: false });
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('Reyna');
      expect(last(screen.getAllByTestId('searchable-select-empty'))?.textContent)
        .toBe('Sin resultados para ese nombre');
    } finally {
      vi.useRealTimers();
    }
  });

  it('com 1 letra a mensagem pede mais letras', () => {
    vi.useFakeTimers();
    try {
      setup(okWorkers, { ...okPatients, points: [], total: 0, truncated: false });
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar('R');
      expect(last(screen.getAllByTestId('searchable-select-empty'))?.textContent)
        .toBe('Escribí al menos 3 letras');
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔒 o seletor de PRESTADOR não busca no servidor: escopo segue o raio', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.click(screen.getByTestId('map-tab-patients'));
      fireEvent.focusIn(screen.getByTestId('map-center-worker'));
      digitar('Reyna', 'map-center-worker');
      expect(pickerCall(mockWorkers)[0]).toEqual(ancoraAR);
      expect(pickerCall(mockWorkers)[0]).not.toHaveProperty('search');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Achados da 2ª passada do gate (07/09/2026).
 */
describe('AdminMapPage — o que a 2ª passada do gate pegou', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function digitar2(texto: string, id = 'map-center-patient'): void {
    const picker = openPicker(id);
    fireEvent.change(within(picker).getByRole('textbox'), { target: { value: texto } });
    act(() => { vi.advanceTimersByTime(400); });
  }

  it('🔒 trocar de aba ABANDONA o termo: voltar não dispara busca por nome', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar2('Reyna');
      expect(pickerCall(mockPatients)[0]).toEqual({ country: 'AR', search: 'Reyna' });

      fireEvent.click(screen.getByTestId('map-tab-patients'));
      fireEvent.click(screen.getByTestId('map-tab-workers'));

      /**
       * SEM avançar o debounce, de propósito. O remount do seletor acaba
       * notificando '' — mas 300 ms depois, e nessa janela o escopo ainda
       * carrega o nome: sai uma request de busca por paciente que ninguém
       * pediu, com a caixa visivelmente vazia. Avançar os timers aqui mediria
       * só o estado final e deixaria a janela passar.
       */
      expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
      expect(pickerCall(mockPatients)[0]).not.toHaveProperty('search');

      // e continua correto depois que o debounce corre
      act(() => { vi.advanceTimersByTime(400); });
      expect(pickerCall(mockPatients)[0]).toEqual(ancoraAR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔒 achado por nome mas SEM coordenada não vira "essa pessoa não existe"', () => {
    vi.useFakeTimers();
    try {
      // o servidor achou 2, nenhum plotável — a busca funcionou, falta geocódigo
      setup(okWorkers, {
        ...okPatients, points: [PT('x', { lat: null, lng: null })], total: 2, withoutCoordinates: 2, truncated: false,
      });
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar2('Reyna');
      expect(last(screen.getAllByTestId('searchable-select-empty'))?.textContent)
        .toBe('2 encontrado(s), pero sin ubicación registrada');
    } finally {
      vi.useRealTimers();
    }
  });

  it('achado e plotável: nenhuma mensagem de lista vazia', () => {
    vi.useFakeTimers();
    try {
      setup();
      fireEvent.focusIn(screen.getByTestId('map-center-patient'));
      digitar2('Reyna');
      expect(screen.queryAllByTestId('searchable-select-empty')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
