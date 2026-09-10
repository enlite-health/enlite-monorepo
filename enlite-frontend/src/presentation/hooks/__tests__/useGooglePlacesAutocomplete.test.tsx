/**
 * useGooglePlacesAutocomplete — o que o `GooglePlacesAutocomplete.test.tsx` não cobre.
 *
 * Aquele arquivo exercita o hook DE FORA, pelo componente, e é ele que trava a conta do
 * Places (um widget por campo, não por tecla). Aqui ficam as duas coisas que só se veem
 * por dentro:
 *
 *  • **lex C1 — a lista de sugestões mascarada para o Clarity.** O widget legado do Google
 *    não desenha as sugestões dentro do `<input>`: cria um `div.pac-container` e o pendura
 *    em `document.body`. O Clarity mascara texto de `<input>` em todos os modos, mas `div`
 *    solto é texto comum — sem esta marca, o domicílio do paciente entraria em session
 *    replay da Microsoft, um SEGUNDO controlador além do Google. `data-clarity-mask` no
 *    wrapper do campo não alcança o nó: ele não é descendente dele.
 *  • **`enabled: false`** — tela que renderiza o campo condicionalmente não pode baixar o
 *    Maps nem acender "erro ao carregar" num campo que não está lá.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useRef } from 'react';
import { useGooglePlacesAutocomplete } from '../useGooglePlacesAutocomplete';

/** O construtor do Google pendura o dropdown no body — é isso que o fake reproduz. */
let pendurarNoConstrutor: boolean;
let widgetsCriados: number;

function stubGoogle(): void {
  class AutocompleteFake {
    constructor() {
      widgetsCriados += 1;
      if (pendurarNoConstrutor) {
        const pac = document.createElement('div');
        pac.className = 'pac-container';
        document.body.appendChild(pac);
      }
    }
    addListener(): void { /* sem seleção nestes casos */ }
    getPlace(): undefined { return undefined; }
  }
  vi.stubGlobal('google', {
    maps: {
      places: { Autocomplete: AutocompleteFake, PlacesServiceStatus: { OK: 'OK' } },
      event: { clearInstanceListeners: vi.fn() },
    },
  });
}

function Campo({ enabled = true }: { enabled?: boolean }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const { apiError } = useGooglePlacesAutocomplete({
    inputRef,
    enabled,
    onPlaceApplied: () => undefined,
  });
  return (
    <>
      <input ref={inputRef} data-testid="campo" />
      {apiError && <span data-testid="aviso">{apiError}</span>}
    </>
  );
}

async function assentar(ms = 50): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

beforeEach(() => {
  document.querySelectorAll('script[src*="maps.googleapis.com"]').forEach((s) => s.remove());
  document.querySelectorAll('.pac-container').forEach((el) => el.remove());
  widgetsCriados = 0;
  pendurarNoConstrutor = true;
  stubGoogle();
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('useGooglePlacesAutocomplete — o dropdown do Google e o Clarity (lex C1)', () => {
  it('o `pac-container` criado JUNTO com o widget sai mascarado', async () => {
    render(<Campo />);
    await assentar();

    const pac = document.querySelector('.pac-container');
    expect(pac, 'o fake pendurou o dropdown').not.toBeNull();
    expect(pac).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('o `pac-container` que aparece DEPOIS também sai mascarado', async () => {
    // O Google nem sempre pendura o nó no construtor: em algumas versões ele só nasce na
    // primeira predição. Se a marca dependesse só da varredura inicial, este caso passaria
    // batido — e é justamente o caminho de quem está digitando.
    pendurarNoConstrutor = false;
    render(<Campo />);
    await assentar();
    expect(document.querySelector('.pac-container')).toBeNull();

    await act(async () => {
      const pac = document.createElement('div');
      pac.className = 'pac-container';
      document.body.appendChild(pac);
      // O MutationObserver entrega na microtarefa seguinte.
      await Promise.resolve();
    });

    expect(document.querySelector('.pac-container')).toHaveAttribute('data-clarity-mask', 'True');
  });

  it('CONTROLE POSITIVO: sem o hook montado, ninguém marca nada', async () => {
    // Sem esta asserção, os dois casos acima poderiam estar medindo um `data-clarity-mask`
    // que viesse de qualquer outro lugar do ambiente de teste.
    const pac = document.createElement('div');
    pac.className = 'pac-container';
    document.body.appendChild(pac);
    await assentar(10);

    expect(pac).not.toHaveAttribute('data-clarity-mask');
  });

  it('ao desmontar, o observador para de marcar', async () => {
    const { unmount } = render(<Campo />);
    await assentar();
    unmount();

    await act(async () => {
      const pac = document.createElement('div');
      pac.className = 'pac-container';
      pac.id = 'depois-do-unmount';
      document.body.appendChild(pac);
      await Promise.resolve();
    });

    expect(document.getElementById('depois-do-unmount')).not.toHaveAttribute('data-clarity-mask');
  });
});

describe('useGooglePlacesAutocomplete — `enabled: false`', () => {
  it('não cria widget, não injeta script e não acende aviso', async () => {
    render(<Campo enabled={false} />);
    await assentar();

    expect(widgetsCriados).toBe(0);
    expect(document.querySelector('script[src*="maps.googleapis.com"]')).toBeNull();
    expect(document.querySelector('[data-testid="aviso"]')).toBeNull();
  });

  it('CONTROLE POSITIVO: com `enabled` padrão, o mesmo cenário CRIA o widget', async () => {
    render(<Campo />);
    await assentar();
    expect(widgetsCriados).toBe(1);
  });
});
