/**
 * CorridorPanel.test.tsx
 *
 * Dois eixos:
 *
 * 1. **A baldeação é destaque.** Em Buenos Aires não existe terminal e trocar de
 *    veículo obriga a andar até outra parada e pagar de novo (Marcel, 02/09).
 *    "directo" tem de ser dito com todas as letras — é o que decide se o
 *    prestador aceita o caso.
 * 2. **As três saídas são três mensagens.** "não há trajeto" e "falta a
 *    localização de um dos dois" são coisas diferentes; colapsá-las faria o
 *    operador ler falta de dado como ausência de transporte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CorridorPanel, type CorridorLabels } from './CorridorPanel';
import { corridorLabelsFor } from './mapPageConfig';
import type { CorridorRequest, CorridorResponse, TransitRoute } from '@infrastructure/http/AdminMapApiService';

const mockCorridor = vi.fn();
vi.mock('@hooks/admin/useCorridor', () => ({ useCorridor: (p: unknown) => mockCorridor(p) }));

const PAR: CorridorRequest = { country: 'AR', workerId: 'w-1', patientAddressId: 'a-1' };

const labels: CorridorLabels = {
  loading: 'Buscando recorrido…',
  error: 'No se pudo calcular el recorrido.',
  noRoute: 'No hay recorrido en transporte público',
  noCoverage: 'Falta la ubicación de uno de los dos',
  direct: 'directo',
  transfers: (n) => `${n} combinación(es)`,
  total: (m) => `${m} min puerta a puerta`,
  walkLeg: (m, meters) => `caminar ${m} min (${meters} m)`,
  straight: (b) => `en línea recta: ~${b} cuadras`,
};

const rota = (over: Partial<TransitRoute> = {}): TransitRoute => ({
  totalMinutes: 34,
  transfers: 0,
  lines: ['8'],
  legs: [
    { kind: 'walk', minutes: 4, meters: 320 },
    { kind: 'transit', minutes: 26, line: '8', mode: 'bus', from: '459 Libertad', to: 'H. Yrigoyen 340' },
    { kind: 'walk', minutes: 4, meters: 240 },
  ],
  ...over,
});

const ok = (routes: TransitRoute[]): CorridorResponse => ({ outcome: 'ok', straightLineMeters: 1167, routes });

type Estado = { data: CorridorResponse | null; isLoading: boolean; error: string | null };
const show = (state: Estado) => {
  mockCorridor.mockReturnValue(state);
  return render(<CorridorPanel pair={PAR} labels={labels} />);
};

describe('CorridorPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('busca o corredor do PAR recebido, no monte do painel', () => {
    show({ data: null, isLoading: true, error: null });
    expect(mockCorridor).toHaveBeenCalledWith(PAR);
  });

  it('mostra tempo porta a porta, e a PRIMEIRA rota nasce aberta com o passo a passo', () => {
    show({ data: ok([rota()]), isLoading: false, error: null });

    expect(screen.getByTestId('corridor-panel')).toHaveAttribute('data-outcome', 'ok');
    const r = screen.getByTestId('route');
    expect(r).toHaveTextContent('34 min puerta a puerta');
    expect(r).toHaveAttribute('data-transfers', '0');

    // a primeira já vem expandida: é a resposta, não uma opção entre outras
    const pernas = within(r).getAllByTestId('route-leg');
    expect(pernas).toHaveLength(3);
    expect(pernas[0]).toHaveTextContent('caminar 4 min (320 m)');
    expect(pernas[1]).toHaveTextContent('459 Libertad → H. Yrigoyen 340 · 26 min');
    expect(pernas[1]).toHaveAttribute('data-line', '8');
    expect(pernas[2]).toHaveAttribute('data-kind', 'walk');
  });

  it('REGRA-10: rota sem troca diz "directo"; com troca, diz quantas', () => {
    show({ data: ok([rota(), rota({ transfers: 2, lines: ['24', '132', '7'], totalMinutes: 41 })]), isLoading: false, error: null });
    const rotas = screen.getAllByTestId('route');
    expect(rotas[0]).toHaveTextContent('directo');
    expect(rotas[1]).toHaveTextContent('2 combinación(es)');
    expect(rotas[1]).toHaveTextContent('24 → 132 → 7');
  });

  it('só uma rota fica aberta por vez, e dá para fechar a que está aberta', () => {
    show({ data: ok([rota(), rota({ totalMinutes: 41, lines: ['24'] })]), isLoading: false, error: null });
    const rotas = screen.getAllByTestId('route');
    expect(within(rotas[0]).queryAllByTestId('route-leg').length).toBeGreaterThan(0);
    expect(within(rotas[1]).queryAllByTestId('route-leg')).toHaveLength(0);

    fireEvent.click(within(rotas[1]).getByTestId('route-summary'));
    expect(within(screen.getAllByTestId('route')[0]).queryAllByTestId('route-leg')).toHaveLength(0);
    expect(within(screen.getAllByTestId('route')[1]).queryAllByTestId('route-leg').length).toBeGreaterThan(0);

    // clicar de novo na aberta fecha — nenhuma fica aberta
    fireEvent.click(within(screen.getAllByTestId('route')[1]).getByTestId('route-summary'));
    expect(screen.queryAllByTestId('route-leg')).toHaveLength(0);
  });

  it('"não há trajeto" e "falta localização" são mensagens DIFERENTES', () => {
    const { unmount } = show({ data: { outcome: 'sem_ruta', straightLineMeters: 900, routes: [] }, isLoading: false, error: null });
    expect(screen.getByTestId('corridor-no-route')).toHaveTextContent('No hay recorrido en transporte público');
    expect(screen.queryByTestId('corridor-no-coverage')).toBeNull();
    // a distância continua sendo dita: pode ser perto o bastante para ir a pé
    expect(screen.getByTestId('corridor-straight')).toHaveTextContent('~9 cuadras');
    unmount();

    show({ data: { outcome: 'sem_cobertura', straightLineMeters: null, routes: [] }, isLoading: false, error: null });
    expect(screen.getByTestId('corridor-no-coverage')).toHaveTextContent('Falta la ubicación');
    expect(screen.queryByTestId('corridor-no-route')).toBeNull();
    // sem as duas pontas não há distância a afirmar
    expect(screen.queryByTestId('corridor-straight')).toBeNull();
  });

  it('carregando e erro têm cada um a sua forma; o erro cru do servidor não vai para a tela', () => {
    const { unmount } = show({ data: null, isLoading: true, error: null });
    expect(screen.getByTestId('corridor-loading')).toHaveTextContent('Buscando recorrido…');
    unmount();

    show({ data: null, isLoading: false, error: 'HTTP 500' });
    expect(screen.getByTestId('corridor-error')).toHaveTextContent('No se pudo calcular el recorrido.');
    expect(screen.getByTestId('corridor-error')).not.toHaveTextContent('HTTP 500');
  });

  it('sem dado e sem erro cai no aviso — nunca num painel em branco', () => {
    show({ data: null, isLoading: false, error: null });
    expect(screen.getByTestId('corridor-error')).toBeInTheDocument();
  });

  it('trem e subte entram pelo mesmo caminho que colectivo', () => {
    show({ data: ok([rota({ lines: ['Mitre'], legs: [{ kind: 'transit', minutes: 20, line: 'Mitre', mode: 'train', from: 'x', to: 'y' }] })]), isLoading: false, error: null });
    expect(screen.getByTestId('route-leg')).toHaveTextContent('Mitre');
  });

  it('caminhada de zero metro (o backend normaliza quando o Google omite) aparece como 0 m, não vazio', () => {
    show({ data: ok([rota({ legs: [{ kind: 'walk', minutes: 3, meters: 0 }, { kind: 'transit', minutes: 10, line: '8', mode: 'bus', from: 'a', to: 'b' }] })]), isLoading: false, error: null });
    expect(screen.getAllByTestId('route-leg')[0]).toHaveTextContent('caminar 3 min (0 m)');
  });

  it('C-13 (lex): o painel leva data-clarity-mask EXPLÍCITO — nome de parada e horário não vão para a gravação', () => {
    show({ data: ok([rota()]), isLoading: false, error: null });
    expect(screen.getByTestId('corridor-panel')).toHaveAttribute('data-clarity-mask', 'True');
  });

  describe('corridorLabelsFor', () => {
    it('monta os rótulos a partir do i18n, interpolando minutos e metros', () => {
      // o `t` real aceita as DUAS formas: `t(key, 'fallback')` e
      // `t(key, { defaultValue, ...interpolação })`. Um fake que só entende a
      // segunda devolve a CHAVE nos rótulos simples.
      const t = ((key: string, opts?: string | Record<string, unknown>) => {
        if (typeof opts === 'string') return opts;
        let s = String(opts?.defaultValue ?? key);
        for (const [k, v] of Object.entries(opts ?? {})) s = s.replace(`{{${k}}}`, String(v));
        return s;
      }) as unknown as Parameters<typeof corridorLabelsFor>[0];

      const l = corridorLabelsFor(t);
      expect(l.total(34)).toBe('34 min puerta a puerta');
      expect(l.transfers(2)).toBe('2 combinación(es)');
      expect(l.walkLeg(4, 320)).toBe('caminar 4 min (320 m)');
      expect(l.straight(12)).toBe('en línea recta: ~12 cuadras');
      expect(l.direct).toBe('directo');
      expect(l.loading).toBe('Buscando recorrido…');
      expect(l.error).toBe('No se pudo calcular el recorrido.');
      expect(l.noRoute).toContain('transporte público');
      expect(l.noCoverage).toContain('Falta la ubicación');
    });
  });
});
