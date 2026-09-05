/**
 * CorridorPanel.test.tsx
 *
 * O que se afirma aqui é que as TRÊS saídas continuam sendo três mensagens
 * diferentes. Colapsá-las em "nada encontrado" faria o operador ler falta de
 * dado ("não tenho paradas nesta zona") como ausência de transporte — e mandar
 * ou não mandar um prestador para um caso por causa disso.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CorridorPanel, type CorridorLabels } from './CorridorPanel';
import { corridorLabelsFor } from './mapPageConfig';
import type { CorridorResponse } from '@infrastructure/http/AdminMapApiService';

const labels: CorridorLabels = {
  title: (n) => `${n} línea(s) sirven ambos puntos`,
  loading: 'Buscando líneas…',
  error: 'No se pudo calcular el recorrido.',
  noDirect: 'Ninguna línea sirve los dos puntos',
  noCoverage: 'Sin datos de paradas en esta zona',
  walk: (b) => `a pie: ~${b} cuadras`,
  legs: (o, d) => `${o} cuadras → ${d} cuadras`,
};

const line = (n: string, over: Partial<CorridorResponse['lines'][0]> = {}) => ({
  line: n, mode: 'bus', originBlocks: 1, originStopName: `origem ${n}`,
  destinationBlocks: 2, destinationStopName: `destino ${n}`, ...over,
});

const ok = (lines: CorridorResponse['lines']): CorridorResponse => ({
  outcome: 'ok', straightLineMeters: 1167, straightLineBlocks: 12, lines,
});

const show = (state: Parameters<typeof CorridorPanel>[0]['state']) =>
  render(<CorridorPanel state={state} labels={labels} />);

describe('CorridorPanel', () => {
  it('mostra as linhas que servem os dois pontos, com as quadras de cada ponta', () => {
    show({ data: ok([line('6'), line('50'), line('8')]), isLoading: false, error: null });

    expect(screen.getByTestId('corridor-panel')).toHaveAttribute('data-outcome', 'ok');
    expect(screen.getByTestId('corridor-panel')).toHaveTextContent('3 línea(s) sirven ambos puntos');
    const linhas = screen.getAllByTestId('corridor-line');
    expect(linhas).toHaveLength(3);
    expect(linhas.map((l) => l.getAttribute('data-line'))).toEqual(['6', '50', '8']);
    expect(within(linhas[0]).getByText('1 cuadras → 2 cuadras')).toBeInTheDocument();
    // a caminhada em linha reta entre as duas casas, na mesma unidade
    expect(screen.getByTestId('corridor-walk')).toHaveTextContent('a pie: ~12 cuadras');
  });

  it('REGRA-10: "nenhuma linha direta" é uma RESPOSTA, não um erro nem uma lista vazia', () => {
    show({ data: { outcome: 'sem_conexion_directa', straightLineMeters: 900, straightLineBlocks: 9, lines: [] }, isLoading: false, error: null });

    expect(screen.getByTestId('corridor-no-direct')).toHaveTextContent('Ninguna línea sirve los dos puntos');
    expect(screen.queryByTestId('corridor-lines')).toBeNull();
    expect(screen.queryByTestId('corridor-error')).toBeNull();
    // a caminhada continua sendo dito: pode ser perto o bastante para ir a pé
    expect(screen.getByTestId('corridor-walk')).toHaveTextContent('9 cuadras');
  });

  it('falta de COBERTURA é mensagem própria — não pode virar "não há transporte"', () => {
    show({ data: { outcome: 'sem_cobertura', straightLineMeters: null, straightLineBlocks: null, lines: [] }, isLoading: false, error: null });

    expect(screen.getByTestId('corridor-no-coverage')).toHaveTextContent('Sin datos de paradas en esta zona');
    expect(screen.queryByTestId('corridor-no-direct')).toBeNull();
    // sem as duas pontas não há distância a afirmar
    expect(screen.queryByTestId('corridor-walk')).toBeNull();
  });

  it('carregando e erro têm cada um a sua forma', () => {
    const { unmount } = show({ data: null, isLoading: true, error: null });
    expect(screen.getByTestId('corridor-loading')).toHaveTextContent('Buscando líneas…');
    unmount();

    show({ data: null, isLoading: false, error: 'HTTP 500' });
    expect(screen.getByTestId('corridor-error')).toHaveTextContent('No se pudo calcular el recorrido.');
    // a mensagem crua do servidor NÃO vai para a tela do operador
    expect(screen.getByTestId('corridor-error')).not.toHaveTextContent('HTTP 500');
  });

  it('sem dado e sem erro cai no aviso — nunca num painel em branco', () => {
    show({ data: null, isLoading: false, error: null });
    expect(screen.getByTestId('corridor-error')).toBeInTheDocument();
  });

  it('mostra no máximo 4 linhas no balão, mas o título conta TODAS', () => {
    show({ data: ok(['6', '50', '8', '24', '111', '146'].map((n) => line(n))), isLoading: false, error: null });
    expect(screen.getAllByTestId('corridor-line')).toHaveLength(4);
    expect(screen.getByTestId('corridor-panel')).toHaveTextContent('6 línea(s) sirven ambos puntos');
  });

  it('trem e subte usam ícone próprio, e o modo não muda o resto', () => {
    show({ data: ok([line('Mitre', { mode: 'train' }), line('D', { mode: 'subway' }), line('8')]), isLoading: false, error: null });
    expect(screen.getAllByTestId('corridor-line')).toHaveLength(3);
    expect(screen.getByTestId('corridor-panel')).toHaveTextContent('Mitre');
  });

  it('C-13 (lex): o painel leva data-clarity-mask EXPLÍCITO — nome de parada e quadras a pé não vão para a gravação', () => {
    show({ data: ok([line('6')]), isLoading: false, error: null });
    expect(screen.getByTestId('corridor-panel')).toHaveAttribute('data-clarity-mask', 'True');
  });

  describe('corridorLabelsFor', () => {
    it('monta os rótulos a partir do i18n, interpolando contagem e quadras', () => {
      // o `t` real aceita as DUAS formas: `t(key, 'fallback')` e
      // `t(key, { defaultValue, ...interpolação })`. Um fake que só entende a
      // segunda devolve a CHAVE nos rótulos simples — e o teste passaria a
      // afirmar 'admin.map.corridor.loading' como se fosse texto.
      const t = ((key: string, opts?: string | Record<string, unknown>) => {
        if (typeof opts === 'string') return opts;
        let s = String(opts?.defaultValue ?? key);
        for (const [k, v] of Object.entries(opts ?? {})) s = s.replace(`{{${k}}}`, String(v));
        return s;
      }) as unknown as Parameters<typeof corridorLabelsFor>[0];

      const l = corridorLabelsFor(t);
      expect(l.title(3)).toBe('3 línea(s) sirven ambos puntos');
      expect(l.walk(12)).toBe('a pie: ~12 cuadras');
      expect(l.legs(1, 2)).toBe('1 cuadras → 2 cuadras');
      expect(l.loading).toBe('Buscando líneas…');
      expect(l.error).toBe('No se pudo calcular el recorrido.');
      expect(l.noDirect).toContain('se paga de nuevo');
      expect(l.noCoverage).toContain('Sin datos de paradas');
    });
  });
});
