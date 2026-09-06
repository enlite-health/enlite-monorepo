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
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CorridorPanel, type CorridorLabels } from './CorridorPanel';
import { corridorLabelsFor } from './mapPageConfig';
import type { CorridorRequest, CorridorResponse, RouteLeg, TransitRoute } from '@infrastructure/http/AdminMapApiService';

const mockCorridor = vi.fn();
vi.mock('@hooks/admin/useCorridor', () => ({ useCorridor: (p: unknown) => mockCorridor(p) }));

const PAR: CorridorRequest = { country: 'AR', workerId: 'w-1', patientAddressId: 'a-1' };

const labels: CorridorLabels = {
  options: (n) => (n === 1 ? '1 opción' : `${n} opciones`),
  loading: 'Buscando recorrido…',
  error: 'No se pudo calcular el recorrido.',
  noRoute: 'No hay recorrido en transporte público',
  noCoverage: 'Falta la ubicación de uno de los dos',
  direct: 'directo',
  transfers: (n) => (n === 1 ? '1 combinación' : `${n} combinaciones`),
  total: (m) => `${m} min puerta a puerta`,
  walkLeg: (m, meters) => `caminar ${m} min (${meters} m)`,
  straight: (b) => `en línea recta: ~${b} cuadras`,
};

/** Polilinha codificada de verdade (captura de 06/09). O painel nunca a mostra. */
const TRACADO = 'r|rnEnjmxJ?kBnAA';

const rota = (over: Partial<TransitRoute> = {}): TransitRoute => ({
  totalMinutes: 34,
  transfers: 0,
  lines: ['8'],
  // `paths` é o traçado desenhado no mapa; aqui vazio de propósito — este
  // arquivo testa o PAINEL, e o desenho tem teste próprio (useRouteOverlay).
  legs: [
    { kind: 'walk', minutes: 4, meters: 320, paths: [] },
    { kind: 'transit', minutes: 26, line: '8', mode: 'bus', from: '459 Libertad', to: 'H. Yrigoyen 340', paths: [TRACADO], color: '#3061f2' },
    { kind: 'walk', minutes: 4, meters: 240, paths: [] },
  ],
  ...over,
});

const ok = (routes: TransitRoute[]): CorridorResponse => ({ outcome: 'ok', straightLineMeters: 1167, routes });

type Estado = { data: CorridorResponse | null; isLoading: boolean; error: string | null };
const show = (state: Estado, onRouteOpen?: (legs: RouteLeg[] | null) => void) => {
  mockCorridor.mockReturnValue(state);
  return render(<CorridorPanel pair={PAR} labels={labels} onRouteOpen={onRouteOpen} />);
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
    // as paradas ficam numa linha PRÓPRIA, que quebra em vez de truncar: nome de
    // parada portenha é longo, e "onde desço" é metade da resposta
    expect(pernas[1]).toHaveTextContent('26 min');
    expect(within(pernas[1]).getByTestId('route-leg-stops'))
      .toHaveTextContent('459 Libertad → H. Yrigoyen 340');
    expect(pernas[1]).toHaveAttribute('data-line', '8');
    expect(pernas[2]).toHaveAttribute('data-kind', 'walk');
  });

  it('REGRA-10: rota sem troca diz "directo"; com troca, diz quantas', () => {
    show({ data: ok([rota(), rota({ transfers: 2, lines: ['24', '132', '7'], totalMinutes: 41 })]), isLoading: false, error: null });
    const rotas = screen.getAllByTestId('route');
    expect(rotas[0]).toHaveTextContent('directo');
    expect(rotas[1]).toHaveTextContent('2 combinaciones');
    expect(rotas[1]).toHaveTextContent('24 → 132 → 7');
  });

  describe('avisa qual rota desenhar no mapa', () => {
    it('avisa a 1ª rota assim que a RESPOSTA chega, sem esperar clique', () => {
      // A 1ª nasce aberta no acordeão. Se o aviso saísse só no clique, o mapa
      // ficaria sem traçado até alguém tocar no painel — e o desenho é a
      // resposta, não um extra que se pede.
      const aviso = vi.fn();
      const rotas = [rota(), rota({ totalMinutes: 41, lines: ['24'] })];
      show({ data: ok(rotas), isLoading: false, error: null }, aviso);

      expect(aviso).toHaveBeenLastCalledWith(rotas[0].legs);
    });

    it('trocar de opção avisa a NOVA; fechar a aberta avisa `null`', () => {
      const aviso = vi.fn();
      const rotas = [rota(), rota({ totalMinutes: 41, lines: ['24'] })];
      show({ data: ok(rotas), isLoading: false, error: null }, aviso);

      fireEvent.click(screen.getAllByTestId('route-summary')[1]);
      expect(aviso).toHaveBeenLastCalledWith(rotas[1].legs);

      fireEvent.click(screen.getAllByTestId('route-summary')[1]);
      expect(aviso).toHaveBeenLastCalledWith(null);
    });

    it('🔒 C5: desmontar avisa `null` — é o que apaga a linha ao fechar o balão', () => {
      const aviso = vi.fn();
      const { unmount } = show({ data: ok([rota()]), isLoading: false, error: null }, aviso);
      aviso.mockClear();

      unmount();
      expect(aviso).toHaveBeenCalledWith(null);
    });

    it('sem rota (carregando, erro ou sem cobertura) avisa `null`, nunca lixo', () => {
      const aviso = vi.fn();
      show({ data: null, isLoading: true, error: null }, aviso);
      expect(aviso).toHaveBeenLastCalledWith(null);

      aviso.mockClear();
      show({ data: { outcome: 'sem_cobertura', straightLineMeters: null, routes: [] }, isLoading: false, error: null }, aviso);
      expect(aviso).toHaveBeenLastCalledWith(null);
    });

    it('🔒 arrow INLINE não causa laço: o aviso vai por ref, não pela dependência', () => {
      // Sem a ref, uma arrow nova a cada render reentraria no efeito, chamaria o
      // `setState` do pai e voltaria — laço infinito. O contrato estava só em
      // comentário até o gate de 06/09.
      let chamadas = 0;
      const Pai = (): JSX.Element => {
        const [, setLegs] = useState<RouteLeg[] | null>(null);
        return <CorridorPanel pair={PAR} labels={labels} onRouteOpen={(l) => { chamadas++; setLegs(l); }} />;
      };
      mockCorridor.mockReturnValue({ data: ok([rota()]), isLoading: false, error: null });

      expect(() => render(<Pai />)).not.toThrow();
      // uma vez na montagem; não uma por render
      expect(chamadas).toBe(1);
    });

    it('sem quem ouvir, o painel funciona igual — o desenho é opcional', () => {
      expect(() => show({ data: ok([rota()]), isLoading: false, error: null })).not.toThrow();
      expect(screen.getByTestId('routes-count')).toBeInTheDocument();
    });
  });

  it('os ÍCONES saem no azul do tema — menos o de aviso, que é âmbar por significado', () => {
    const { container } = show({ data: ok([rota()]), isLoading: false, error: null });

    // lucide desenha `<svg class="...">`; a cor vem do `currentColor` da classe.
    const svgs = Array.from(container.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThan(2);
    for (const svg of svgs) expect(svg.getAttribute('class')).toContain('text-primary');
    // e nenhum sobrou no cinza quase branco da escala da casa
    for (const svg of svgs) expect(svg.getAttribute('class')).not.toMatch(/text-gray-(400|500|600)/);
  });

  it('o ícone do AVISO continua âmbar — ali a cor é o sinal, não a decoração', () => {
    // Uniformizar este também apagaria a diferença entre "aqui está a rota" e
    // "não consegui calcular" — que é justamente o que o operador precisa ver.
    const { container } = show({ data: { outcome: 'sem_ruta', straightLineMeters: null, routes: [] }, isLoading: false, error: null });

    const svg = container.querySelector('[data-testid="corridor-no-route"] svg');
    expect(svg?.getAttribute('class')).toContain('text-amber-600');
    expect(svg?.getAttribute('class')).not.toContain('text-primary');
  });

  it('🔒 C4 do parecer: o TRAÇADO chega ao painel mas NUNCA vira DOM', () => {
    // A máscara do Clarity cobre "o nó e o conteúdo dos filhos" — conteúdo, não
    // valor de atributo. E este painel já usa atributos de dado (`data-minutes`,
    // `data-transfers`), então a tentação de pendurar a polilinha num
    // `data-path` é real. Ela não pode existir: os vértices das pontas são os
    // dois domicílios, e atributo é o que escapa da máscara.
    const { container } = show({ data: ok([rota()]), isLoading: false, error: null });

    expect(container.innerHTML).not.toContain(TRACADO);
    expect(container.innerHTML).not.toContain('encodedPolyline');
    expect(container.querySelector('[data-path]')).toBeNull();
    expect(container.querySelector('[data-polyline]')).toBeNull();
    // e o painel continua respondendo a pergunta que ele existe para responder
    expect(screen.getByTestId('routes-count')).toHaveTextContent('1 opción');
  });

  it('o que decide sai na cor do TEMA — contagem, tempo e linha — e o resto não', () => {
    show({ data: ok([rota()]), isLoading: false, error: null });

    // `text-primary` é o #180149 do tema, o mesmo da aba ativa e dos links.
    // A contagem entrou nesta lista em 05/09, a pedido do Gabriel: ela é o que
    // diz "há alternativas", e em cinza passava por legenda de tabela.
    expect(screen.getByTestId('routes-count').className).toContain('text-primary');
    const tempo = screen.getByText('34 min puerta a puerta');
    expect(tempo.className).toContain('text-primary');
    const linha = within(screen.getAllByTestId('route-leg')[1]).getByText('8');
    expect(linha.className).toContain('text-primary');

    // e o resto NÃO: se tudo é destaque, nada é. A caminhada e o nome da parada
    // são CONTEXTO — quem decide já leu o tempo e a linha.
    expect(screen.getByText('caminar 4 min (320 m)').className).not.toContain('text-primary');
    expect(screen.getByTestId('route-leg-stops').className).not.toContain('text-primary');
  });

  it('cada rota é uma OPÇÃO fechada: contagem no topo, numeradas, e as pernas presas à sua opção', () => {
    // Na 1ª versão as pernas da opção aberta e o cabeçalho da seguinte
    // empilhavam sem separação: o balão lia como UM trajeto de 5 passos em vez
    // de TRÊS alternativas. Este teste trava os três sinais que consertam isso.
    show({ data: ok([rota(), rota({ totalMinutes: 41, lines: ['24'] }), rota({ totalMinutes: 55, lines: ['B'] })]), isLoading: false, error: null });

    expect(screen.getByTestId('routes-count')).toHaveTextContent('3 opciones');
    // teto de altura: sem ele o balão estoura a borda de cima do mapa e corta o
    // nome do paciente e os links (medido em 05/09, no print)
    // Peso das bordas. Em `gray-200` a moldura sumia contra o branco do balão
    // (Gabriel, 05/09) e a lista voltava a ler como um trajeto só.
    // 🔒 Os NÚMEROS importam e não seguem o Tailwind padrão: nesta casa
    // 300=#EEEEEE e 400=#ECEFF1 (o 400 é mais CLARO que o 300). Só 600=#D9D9D9
    // e 800=#737373 são borda visível. Trocar por um número "maior" pode
    // clarear — por isso o teste trava o TOM, não só a existência da classe.
    expect(screen.getByTestId('routes').className).toContain('border-gray-600');
    expect(screen.getByTestId('routes').className).toContain('divide-gray-600');
    expect(screen.getByTestId('route-legs').className).toContain('border-gray-800');
    // 260px, não menos: a 190 a rota com baldeação escondia 2 das 5 pernas
    // (medido em 05/09) — inclusive a parada de desembarque, que é a pergunta.
    expect(screen.getByTestId('routes').className).toContain('max-h-[260px]');
    expect(screen.getByTestId('routes').className).toContain('overflow-y-auto');

    const rotas = screen.getAllByTestId('route');
    expect(rotas).toHaveLength(3);
    rotas.forEach((r, i) => expect(r).toHaveTextContent(`${i + 1}.`));

    // as pernas moram DENTRO da opção aberta, não soltas no balão
    expect(rotas[0]).toHaveAttribute('data-open', 'true');
    expect(within(rotas[0]).getAllByTestId('route-leg').length).toBe(3);
    expect(rotas[1]).toHaveAttribute('data-open', 'false');
    expect(within(rotas[1]).queryAllByTestId('route-leg')).toHaveLength(0);

    // e o cabeçalho anuncia o estado para quem usa leitor de tela
    expect(within(rotas[0]).getByTestId('route-summary')).toHaveAttribute('aria-expanded', 'true');
    expect(within(rotas[1]).getByTestId('route-summary')).toHaveAttribute('aria-expanded', 'false');
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
    show({ data: ok([rota({ lines: ['Mitre'], legs: [{ kind: 'transit', minutes: 20, line: 'Mitre', mode: 'train', from: 'x', to: 'y', paths: [], color: '#1b6633'  }] })]), isLoading: false, error: null });
    expect(screen.getByTestId('route-leg')).toHaveTextContent('Mitre');
  });

  it('caminhada de zero metro (o backend normaliza quando o Google omite) aparece como 0 m, não vazio', () => {
    show({ data: ok([rota({ legs: [{ kind: 'walk', minutes: 3, meters: 0, paths: [] }, { kind: 'transit', minutes: 10, line: '8', mode: 'bus', from: 'a', to: 'b', paths: [], color: '#1b6633'  }] })]), isLoading: false, error: null });
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
        // o i18next escolhe `_one`/`_other` pelo `count` — o fake faz o mesmo,
        // senão o teste afirmaria a chave em vez do texto
        const plural = opts?.count === 1 ? opts?.defaultValue_one : opts?.defaultValue_other;
        let s = String(plural ?? opts?.defaultValue ?? key);
        for (const [k, v] of Object.entries(opts ?? {})) s = s.replace(`{{${k}}}`, String(v));
        return s;
      }) as unknown as Parameters<typeof corridorLabelsFor>[0];

      const l = corridorLabelsFor(t);
      // plural pelo i18next: singular tem texto PRÓPRIO, não "(es)" grudado
      expect(l.options(3)).toBe('3 opciones');
      expect(l.options(1)).toBe('1 opción');
      expect(l.transfers(1)).toBe('1 combinación');
      expect(l.transfers(2)).toBe('2 combinaciones');
      expect(l.total(34)).toBe('34 min puerta a puerta');

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
