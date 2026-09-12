/**
 * GooglePlacesAutocomplete — a guarda do CUSTO, não só do comportamento.
 *
 * O que este arquivo existe para impedir: um widget do Google criado POR TECLA.
 * Cada `new google.maps.places.Autocomplete()` abre uma sessão de Places, e sessão
 * que não fecha num Place Details é a linha cara do SKU (US$ 17/1.000, franquia de
 * 5.000/mês, contra grátis quando fecha). Medido em produção (07/09/2026), uma
 * corrida do `worker-journey` digitando UM endereço de 19 caracteres gerou
 * **309 chamadas de Autocomplete para 1 Place Details**.
 *
 * A causa era o array de dependências do efeito de inicialização: com
 * `[onPlaceSelected, onChange, onValidationChange]` lá, qualquer pai que passasse
 * arrow inline (o `WorkerEditModal` passa, linha 336) trocava a identidade a cada
 * render — e o campo re-renderiza a cada tecla. O primeiro teste é o controle
 * POSITIVO disso: passa o callback como arrow inline de propósito, que é o uso real
 * que quebrava, e conta 20 widgets se o defeito voltar.
 */
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { useState } from 'react';
import { GooglePlacesAutocomplete } from '../GooglePlacesAutocomplete';
// A URL do script vem da FONTE ÚNICA, nunca escrita à mão: a guarda
// `googleMapsScriptUrl.test.ts` reprova qualquer segunda construção dela no `src/`,
// e o conserto certo (que ela mesma prescreve) é importar, não relaxar a busca.
import { googleMapsScriptUrl } from '@infrastructure/services/googleMapsScriptUrl';

/** Quantos widgets o componente pediu ao Google nesta montagem. */
let instancias: number;
/** Listeners de `place_changed` registrados, para disparar a seleção na mão. */
let placeChangedHandlers: Array<() => void>;
/** O que `getPlace()` devolve — trocado por teste. */
let placeDevolvido: Partial<google.maps.places.PlaceResult> | undefined;
let clearInstanceListeners: Mock;
let getPlacePredictions: Mock;
let getDetails: Mock;

const ENDERECO = 'Av. Corrientes 1234, Buenos Aires';

interface OpcoesStub {
  /** Resposta de `AutocompleteService.getPlacePredictions` (caminho do teclado). */
  predicoes?: { valor: unknown; status: string };
  /** Resposta de `PlacesService.getDetails` (caminho do teclado). */
  detalhes?: { valor: unknown; status: string };
  /** Faz o construtor do widget lançar — para o caminho de erro não-`Error`. */
  construtorLanca?: unknown;
}

/**
 * Instala o `google` global. Fábrica única de propósito: antes havia cinco cópias
 * quase idênticas deste objeto no arquivo, e o gate reprovou (com razão) — stub
 * duplicado é o lugar onde um teste começa a medir outra coisa que o vizinho.
 */
function stubGoogle(opcoes: OpcoesStub = {}): void {
  getPlacePredictions = vi.fn((_req, cb: (p: unknown, s: string) => void) => {
    const p = opcoes.predicoes;
    if (p) cb(p.valor, p.status);
  });
  getDetails = vi.fn((_req, cb: (d: unknown, s: string) => void) => {
    const d = opcoes.detalhes;
    if (d) cb(d.valor, d.status);
  });

  class AutocompleteFake {
    constructor() {
      if (opcoes.construtorLanca !== undefined) throw opcoes.construtorLanca;
      instancias += 1;
    }
    addListener(evento: string, cb: () => void): void {
      if (evento === 'place_changed') placeChangedHandlers.push(cb);
    }
    getPlace(): Partial<google.maps.places.PlaceResult> | undefined {
      return placeDevolvido;
    }
  }

  vi.stubGlobal('google', {
    maps: {
      places: {
        Autocomplete: AutocompleteFake,
        PlacesServiceStatus: { OK: 'OK' },
        AutocompleteService: class {
          getPlacePredictions = getPlacePredictions;
        },
        PlacesService: class {
          getDetails = getDetails;
        },
      },
      event: { clearInstanceListeners },
    },
  });
}

/** Remove o `google` global para exercitar o caminho "ainda não carregou". */
function semGoogle(): void {
  vi.stubGlobal('google', undefined);
}

/** Deixa o efeito assíncrono de inicialização terminar antes de contar/afirmar. */
async function assentar(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  // O <head> do jsdom sobrevive entre testes: um <script> do Maps deixado por um caso
  // faz o seguinte achar que "já está carregando" e nunca injetar o seu. Sem esta
  // limpeza os testes passam ou falham conforme a ORDEM, que é o pior tipo de teste.
  document.querySelectorAll('script[src*="maps.googleapis.com"]').forEach((s) => s.remove());

  instancias = 0;
  placeChangedHandlers = [];
  placeDevolvido = { formatted_address: ENDERECO };
  clearInstanceListeners = vi.fn();

  stubGoogle();
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** O uso REAL que quebrava: pai com estado próprio e callback arrow inline. */
function PaiComArrowInline(): JSX.Element {
  const [valor, setValor] = useState('');
  return (
    <GooglePlacesAutocomplete
      label="Dirección"
      value={valor}
      onChange={(v) => setValor(v)}
      onPlaceSelected={() => undefined}
      onValidationChange={() => undefined}
    />
  );
}

describe('GooglePlacesAutocomplete — custo do Places', () => {
  it('cria UM widget para o campo inteiro, mesmo digitando 19 teclas com callback inline', async () => {
    render(<PaiComArrowInline />);
    await waitFor(() => expect(instancias).toBe(1));

    const input = screen.getByTestId('address-autocomplete-input');
    // 19 caracteres — exatamente o que o e2e-prod digita, e o que produzia 309 chamadas.
    const texto = 'Av. Corrientes 1234';
    for (let i = 1; i <= texto.length; i += 1) {
      fireEvent.change(input, { target: { value: texto.slice(0, i) } });
    }

    // ⚠️ NÃO REMOVER o `assentar()`: a inicialização é async, então as instâncias só
    // nascem no fim do tick. Sem ele a asserção rodava ANTES e media zero — o teste
    // passava com o defeito reintroduzido (verificado por sabotagem em 07/09).
    await assentar();

    expect(
      instancias,
      'um widget por tecla é a conta do Places explodindo — o efeito não pode depender ' +
        'da identidade dos callbacks',
    ).toBe(1);
  });

  it('o widget não é recriado quando só o `value` controlado muda', async () => {
    const { rerender } = render(<GooglePlacesAutocomplete label="Dirección" value="A" />);
    await waitFor(() => expect(instancias).toBe(1));
    rerender(<GooglePlacesAutocomplete label="Dirección" value="Av" />);
    rerender(<GooglePlacesAutocomplete label="Dirección" value="Av. C" />);
    await assentar();
    expect(instancias).toBe(1);
  });

  it('mesmo com UM widget só, a seleção continua chegando ao callback MAIS RECENTE', async () => {
    // A prova de que o "latest ref" não congelou o callback junto com o efeito: se
    // guardássemos a closure da 1ª montagem, o pai receberia o callback velho.
    const primeiro = vi.fn();
    const segundo = vi.fn();
    const { rerender } = render(
      <GooglePlacesAutocomplete label="Dirección" onChange={primeiro} />,
    );
    await waitFor(() => expect(instancias).toBe(1));

    rerender(<GooglePlacesAutocomplete label="Dirección" onChange={segundo} />);
    placeChangedHandlers.forEach((h) => h());

    expect(instancias, 'trocar o callback não pode recriar o widget').toBe(1);
    expect(segundo, 'o callback ATUAL recebe o endereço').toHaveBeenCalledWith(ENDERECO);
    expect(primeiro, 'o callback antigo não é mais chamado').not.toHaveBeenCalled();
  });

  it('escolher um endereço notifica onChange, onPlaceSelected e onValidationChange', async () => {
    const onChange = vi.fn();
    const onPlaceSelected = vi.fn();
    const onValidationChange = vi.fn();

    render(
      <GooglePlacesAutocomplete
        label="Dirección"
        onChange={onChange}
        onPlaceSelected={onPlaceSelected}
        onValidationChange={onValidationChange}
      />,
    );
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    // Os três juntos importam: o formulário guarda o texto (onChange), a tela usa a
    // geometria (onPlaceSelected) e a validação libera o submit (onValidationChange).
    expect(onChange).toHaveBeenCalledWith(ENDERECO);
    expect(onPlaceSelected).toHaveBeenCalledWith(placeDevolvido);
    expect(onValidationChange).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('address-autocomplete-input')).toHaveValue(ENDERECO);
  });

  it('selecionar um endereço SEM nenhum callback passado não quebra', async () => {
    render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    expect(() => {
      placeChangedHandlers.forEach((h) => h());
    }, 'sem callbacks, a seleção é silenciosa — não lança').not.toThrow();
  });
});

describe('GooglePlacesAutocomplete — desmontagem', () => {
  it('ao desmontar, limpa os listeners do widget E do input', async () => {
    const { unmount } = render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(instancias).toBe(1));
    unmount();

    // Dois alvos: o objeto Autocomplete e o <input>. Limpar só o primeiro deixava
    // listeners de instâncias descartadas vivos sobre o mesmo campo.
    expect(clearInstanceListeners).toHaveBeenCalledTimes(2);
    const alvos = clearInstanceListeners.mock.calls.map(([alvo]) => alvo);
    expect(
      alvos.some((a) => a instanceof HTMLInputElement),
      'o <input> também tem de ser limpo',
    ).toBe(true);
  });

  it('desmontar antes do Maps carregar não instancia widget nenhum', async () => {
    // Cobre a guarda `if (!inputRef.current) return`: o efeito é async, e o componente
    // pode sair da tela antes de o script resolver.
    semGoogle();
    const appendChild = vi.spyOn(document.head, 'appendChild');
    const { unmount } = render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(appendChild).toHaveBeenCalled());
    const script = appendChild.mock.calls[0]![0] as HTMLScriptElement;

    unmount(); // o ref cai para null AQUI, antes do onload
    stubGoogle();
    await act(async () => {
      script.onload?.(new Event('load'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(instancias, 'componente desmontado não pede widget ao Google').toBe(0);
  });

  it('`place_changed` que chega DEPOIS do unmount não pergunta nada ao Google', async () => {
    // O widget é do Google e pode disparar o evento depois de o React soltar o campo.
    // Aí `inputRef.current` já é `null` e o texto cai no `?? ''` — que faz
    // `resolveFirstPrediction` sair sem gastar chamada. Sem esse último degrau, um
    // `undefined` viraria consulta ao Places por um campo que já não existe.
    placeDevolvido = {}; // sem `name`: força o fallback a procurar o valor do input
    const { unmount } = render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    unmount();
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(getPlacePredictions, 'campo desmontado não gera consulta').not.toHaveBeenCalled();
  });
});

/**
 * Carregamento do script e modos de erro. Guardam o fallback de texto livre quando o
 * Maps não carrega — o caminho em que o campo tem de degradar, nunca derrubar a tela.
 */
describe('GooglePlacesAutocomplete — carregamento do script e modos de erro', () => {
  it('sem chave de API, cai para texto livre e AVISA — não falha em silêncio', async () => {
    semGoogle();
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<GooglePlacesAutocomplete label="Dirección" />);

    expect(await screen.findByText(/API key não configurada/i)).toBeInTheDocument();
    expect(erro).toHaveBeenCalled();
  });

  it('injeta o script quando ele ainda não existe, e resolve no onload', async () => {
    semGoogle();
    const appendChild = vi.spyOn(document.head, 'appendChild');

    render(<GooglePlacesAutocomplete label="Dirección" />);

    await waitFor(() => expect(appendChild).toHaveBeenCalled());
    const script = appendChild.mock.calls[0]![0] as HTMLScriptElement;
    expect(script.src, 'usa o construtor de URL da casa').toContain('maps.googleapis.com');
    expect(script.async).toBe(true);

    // onload resolve, mas `google` continua ausente → o componente avisa em vez de travar.
    await act(async () => {
      script.onload?.(new Event('load'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(await screen.findByText(/Aguardando Google Maps carregar/i)).toBeInTheDocument();
  });

  it('se o script falha ao carregar, avisa e não fica esperando para sempre', async () => {
    semGoogle();
    const appendChild = vi.spyOn(document.head, 'appendChild');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(appendChild).toHaveBeenCalled());
    const script = appendChild.mock.calls[0]![0] as HTMLScriptElement;

    await act(async () => {
      script.onerror?.(new Event('error'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByText(/Erro ao carregar Google Places/i)).toBeInTheDocument();
  });

  it('reaproveita um script já presente na página em vez de injetar outro', async () => {
    semGoogle();
    const existente = document.createElement('script');
    existente.src = googleMapsScriptUrl('chave-de-teste');
    document.head.appendChild(existente);
    const appendChild = vi.spyOn(document.head, 'appendChild');

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await act(async () => {
      existente.dispatchEvent(new Event('load'));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(appendChild, 'não injeta um segundo script').not.toHaveBeenCalled();
    existente.remove();
  });

  it('script existente que falha também avisa', async () => {
    semGoogle();
    const existente = document.createElement('script');
    existente.src = googleMapsScriptUrl('chave-de-teste');
    document.head.appendChild(existente);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await act(async () => {
      existente.dispatchEvent(new Event('error'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await screen.findByText(/Erro ao carregar Google Places/i)).toBeInTheDocument();
    existente.remove();
  });

  it('erro que não é Error também vira aviso na tela, não tela quebrada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubGoogle({ construtorLanca: 'falha crua' });

    render(<GooglePlacesAutocomplete label="Dirección" />);
    expect(await screen.findByText(/Erro ao carregar Google Places/i)).toBeInTheDocument();
  });
});

/**
 * Confirmação por TECLADO. Existe porque escolher pelo teclado NÃO gravava o endereço
 * (medido em prod, 31/08): o widget dispara `place_changed` sem `formatted_address`.
 */
describe('GooglePlacesAutocomplete — seleção por teclado e validação', () => {
  it('resolve a 1ª predição na mão e grava o endereço (o defeito de 31/08)', async () => {
    placeDevolvido = { name: 'Av. Corrientes 1234' };
    stubGoogle({
      predicoes: { valor: [{ place_id: 'p1' }], status: 'OK' },
      detalhes: { valor: { formatted_address: ENDERECO }, status: 'OK' },
    });
    const onChange = vi.fn();

    render(<GooglePlacesAutocomplete label="Dirección" onChange={onChange} />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(getPlacePredictions).toHaveBeenCalled();
    expect(getDetails).toHaveBeenCalled();
    expect(onChange, 'o endereço resolvido chega ao formulário').toHaveBeenCalledWith(ENDERECO);
  });

  it('campo vazio não gasta chamada nenhuma ao Google', async () => {
    placeDevolvido = undefined;
    stubGoogle();

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(getPlacePredictions, 'sem texto, não se pergunta ao Google').not.toHaveBeenCalled();
  });

  it('sem `name` no place, vale o texto digitado no input', async () => {
    placeDevolvido = {};
    stubGoogle({ predicoes: { valor: [], status: 'OK' } });

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    fireEvent.change(screen.getByTestId('address-autocomplete-input'), {
      target: { value: 'Av. Corrientes' },
    });
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(
      getPlacePredictions.mock.calls[0]![0],
      'sem `name`, quem vale é o que está escrito no campo',
    ).toMatchObject({ input: 'Av. Corrientes' });
  });

  it('sem predição ou com status ruim, não chama Details', async () => {
    placeDevolvido = { name: 'xyz' };
    stubGoogle({ predicoes: { valor: null, status: 'ZERO_RESULTS' } });

    render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(getPlacePredictions).toHaveBeenCalled();
    expect(getDetails, 'sem predição não há Details a pedir').not.toHaveBeenCalled();
  });

  it('Details que falha não grava endereço pela metade', async () => {
    placeDevolvido = { name: 'Av. Corrientes' };
    stubGoogle({
      predicoes: { valor: [{ place_id: 'p1' }], status: 'OK' },
      detalhes: { valor: null, status: 'NOT_FOUND' },
    });
    const onChange = vi.fn();

    render(<GooglePlacesAutocomplete label="Dirección" onChange={onChange} />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(onChange, 'Details ruim não vira endereço gravado').not.toHaveBeenCalled();
  });

  it('Details OK mas SEM endereço formatado não grava nada', async () => {
    // Status OK não basta: gravar `undefined` aqui apagaria o campo do cadastro.
    placeDevolvido = { name: 'Av. Corrientes' };
    stubGoogle({
      predicoes: { valor: [{ place_id: 'p1' }], status: 'OK' },
      detalhes: { valor: { name: 'sem endereço' }, status: 'OK' },
    });
    const onChange = vi.fn();

    render(<GooglePlacesAutocomplete label="Dirección" onChange={onChange} />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(onChange, 'Details sem formatted_address não vira gravação').not.toHaveBeenCalled();
  });

  it('digitar depois de escolher invalida a seleção; sair do campo acusa', async () => {
    const onValidationChange = vi.fn();
    render(
      <GooglePlacesAutocomplete
        label="Dirección"
        value={ENDERECO}
        onValidationChange={onValidationChange}
      />,
    );
    const input = screen.getByTestId('address-autocomplete-input');

    // `value` inicial ⇒ nasce "selecionado". Digitar por cima derruba isso.
    fireEvent.change(input, { target: { value: 'Av. Corr' } });
    expect(onValidationChange).toHaveBeenCalledWith(false);

    fireEvent.blur(input);
    expect(
      await screen.findByText(/selecione um endereço|seleccion/i),
      'o campo precisa DIZER que o endereço não foi escolhido da lista',
    ).toBeInTheDocument();
  });

  it('com requireSelection=false, sair do campo com texto livre não acusa erro', async () => {
    render(
      <GooglePlacesAutocomplete label="Dirección" requireSelection={false} value="texto livre" />,
    );
    const input = screen.getByTestId('address-autocomplete-input');
    fireEvent.change(input, { target: { value: 'qualquer coisa' } });
    fireEvent.blur(input);

    expect(screen.queryByText(/selecione um endereço|seleccion/i)).not.toBeInTheDocument();
  });

  it('a prop `error` do formulário é renderizada abaixo do campo', () => {
    render(<GooglePlacesAutocomplete label="Dirección" error="Dirección obligatoria" />);
    expect(screen.getByText('Dirección obligatoria')).toBeInTheDocument();
  });
});

/**
 * Conserto #4 — predição atrasada.
 *
 * `resolveFirstPrediction` é assíncrono em DOIS saltos (predições → Details) e não
 * tinha nenhuma guarda de obsolescência: usuário digita "A", aperta Enter, desiste,
 * digita "B" — e quando a resposta de "A" volta, ela SOBRESCREVE "B". No cadastro do
 * prestador isso é grave porque `ServiceAddressTab` autossalva a área de serviço no
 * `handlePlaceSelected`: o endereço errado vira zoneamento gravado sem o prestador ver.
 *
 * Estes testes controlam a chegada das respostas NA MÃO: `stubGoogle()` sem opções
 * registra a chamada mas não invoca o callback sozinho — o teste decide quando (e com
 * que valor) a resposta "chega", exatamente o controle que o defeito precisa expor.
 */
describe('GooglePlacesAutocomplete — predição atrasada não sobrescreve o texto atual', () => {
  it('resposta atrasada da predição não sobrescreve o texto já trocado pelo usuário', async () => {
    placeDevolvido = {}; // sem `name`: cai no valor do input, como o Enter real faz
    stubGoogle();
    const onChange = vi.fn();
    const onPlaceSelected = vi.fn();
    const onValidationChange = vi.fn();

    render(
      <GooglePlacesAutocomplete
        label="Dirección"
        onChange={onChange}
        onPlaceSelected={onPlaceSelected}
        onValidationChange={onValidationChange}
      />,
    );
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    const input = screen.getByTestId('address-autocomplete-input');
    fireEvent.change(input, { target: { value: 'A' } });
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    expect(getPlacePredictions).toHaveBeenCalledTimes(1);
    expect(getPlacePredictions.mock.calls[0]![0]).toMatchObject({ input: 'A' });

    // O usuário desiste de "A" e digita "B" ANTES da resposta do Google chegar.
    fireEvent.change(input, { target: { value: 'B' } });

    // A resposta de "A" chega agora, atrasada.
    const callbackDaPredicao = getPlacePredictions.mock.calls[0]![1] as (
      p: unknown,
      s: string,
    ) => void;
    await act(async () => {
      callbackDaPredicao([{ place_id: 'p-a' }], 'OK');
    });

    // Se a guarda não existir, o fluxo segue e pede Details da predição velha — e
    // quando o Details "responde" também, o resultado se aplica por cima de "B".
    if (getDetails.mock.calls.length > 0) {
      const callbackDoDetails = getDetails.mock.calls[0]![1] as (
        d: unknown,
        s: string,
      ) => void;
      await act(async () => {
        callbackDoDetails({ formatted_address: 'Endereço A resolvido' }, 'OK');
      });
    }

    expect(
      input,
      'o texto do usuário é a verdade — a resposta atrasada não pode voltar por cima',
    ).toHaveValue('B');
    expect(onPlaceSelected, 'predição velha não pode aplicar seleção nenhuma').not.toHaveBeenCalled();
    expect(onValidationChange).not.toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalledWith('Endereço A resolvido');
  });

  it('resposta atrasada do Place Details não sobrescreve o texto trocado depois da predição', async () => {
    // Aqui o texto NÃO muda antes da predição resolver (Details chega a ser pedido) —
    // só muda depois, enquanto o Details ainda está no ar. Cobre a guarda que vive no
    // SEGUNDO salto, distinta da guarda do primeiro (coberta pelo teste acima).
    placeDevolvido = {};
    stubGoogle();
    const onChange = vi.fn();
    const onPlaceSelected = vi.fn();

    render(
      <GooglePlacesAutocomplete label="Dirección" onChange={onChange} onPlaceSelected={onPlaceSelected} />,
    );
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    const input = screen.getByTestId('address-autocomplete-input');
    fireEvent.change(input, { target: { value: 'A' } });
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    const callbackDaPredicao = getPlacePredictions.mock.calls[0]![1] as (
      p: unknown,
      s: string,
    ) => void;
    await act(async () => {
      callbackDaPredicao([{ place_id: 'p-a' }], 'OK');
    });
    expect(getDetails, 'texto ainda é "A" — Details é pedido normalmente').toHaveBeenCalledTimes(1);

    // O usuário troca o texto DEPOIS que a predição já resolveu, mas ANTES do Details voltar.
    fireEvent.change(input, { target: { value: 'C' } });

    const callbackDoDetails = getDetails.mock.calls[0]![1] as (d: unknown, s: string) => void;
    await act(async () => {
      callbackDoDetails({ formatted_address: 'Endereço A resolvido' }, 'OK');
    });

    expect(onPlaceSelected, 'Details da predição velha não aplica mais nada').not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalledWith('Endereço A resolvido');
    expect(input).toHaveValue('C');
  });

  it('desmontar entre pedir predições e a resposta chegar não gasta Details', async () => {
    // O `enabled`/unmount zera a mesma guarda de obsolescência: aqui o texto do campo
    // não muda (ele nem existe mais), então só o flag de cancelamento pode barrar.
    placeDevolvido = {};
    stubGoogle();
    const { unmount } = render(<GooglePlacesAutocomplete label="Dirección" />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    const input = screen.getByTestId('address-autocomplete-input');
    fireEvent.change(input, { target: { value: 'A' } });
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });
    expect(getPlacePredictions).toHaveBeenCalledTimes(1);

    unmount();

    const callbackDaPredicao = getPlacePredictions.mock.calls[0]![1] as (
      p: unknown,
      s: string,
    ) => void;
    await act(async () => {
      expect(() => {
        callbackDaPredicao([{ place_id: 'p-a' }], 'OK');
      }, 'resposta depois do unmount não pode lançar').not.toThrow();
    });

    expect(getDetails, 'componente desmontado não pede Details').not.toHaveBeenCalled();
  });

  it('desmontar entre pedir Details e a resposta chegar não aplica nada', async () => {
    placeDevolvido = {};
    stubGoogle();
    const onChange = vi.fn();
    const { unmount } = render(<GooglePlacesAutocomplete label="Dirección" onChange={onChange} />);
    await waitFor(() => expect(placeChangedHandlers.length).toBe(1));

    const input = screen.getByTestId('address-autocomplete-input');
    fireEvent.change(input, { target: { value: 'A' } });
    await act(async () => {
      placeChangedHandlers.forEach((h) => h());
    });

    const callbackDaPredicao = getPlacePredictions.mock.calls[0]![1] as (
      p: unknown,
      s: string,
    ) => void;
    await act(async () => {
      callbackDaPredicao([{ place_id: 'p-a' }], 'OK');
    });
    expect(getDetails).toHaveBeenCalledTimes(1);

    unmount();

    const callbackDoDetails = getDetails.mock.calls[0]![1] as (d: unknown, s: string) => void;
    await act(async () => {
      expect(() => {
        callbackDoDetails({ formatted_address: 'Endereço tardio' }, 'OK');
      }, 'resposta de Details depois do unmount não pode lançar').not.toThrow();
    });

    // `onChange('A')` já aconteceu antes, pelo próprio `fireEvent.change` (teclado
    // normal) — o que a guarda impede é o Details tardio aplicar o endereço por cima.
    expect(
      onChange,
      'componente desmontado não pode receber o endereço resolvido tardiamente',
    ).not.toHaveBeenCalledWith('Endereço tardio');
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
