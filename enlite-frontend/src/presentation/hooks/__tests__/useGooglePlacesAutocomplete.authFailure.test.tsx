/**
 * A chave recusada pelo Google — o modo de falha que a sonda de 10/09/2026 revelou em navegador
 * real e que nenhum teste anterior via.
 *
 * Por que arquivo SEPARADO: a flag "a chave já foi recusada" é estado de MÓDULO (o
 * `window.gm_authFailure` é um só para a página inteira). Vitest isola módulos por arquivo de
 * teste; misturar estes casos com os outros faria a ordem dos testes decidir o resultado.
 *
 * O que foi medido no Chrome real: com a chave recusada, o `<script>` do Maps responde **200**,
 * a `AuthenticationService.Authenticate` responde **200**, o widget é criado — e só então o
 * console recebe `RefererNotAllowedMapError`, o `<input>` volta `disabled` e o placeholder vira
 * *"Se ha producido un error."*. Nenhum caminho de erro de carregamento dispara. Como o domicílio
 * do paciente só nasce de uma escolha na lista, sem este aviso o operador fica sem saída e sem pista.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useRef } from 'react';
import { useGooglePlacesAutocomplete } from '../useGooglePlacesAutocomplete';

interface JanelaComGoogleAuth extends Window { gm_authFailure?: () => void }

function stubGoogle(): void {
  class AutocompleteFake {
    addListener(): void { /* sem seleção nestes casos */ }
    getPlace(): undefined { return undefined; }
  }
  vi.stubGlobal('google', {
    maps: { places: { Autocomplete: AutocompleteFake, PlacesServiceStatus: { OK: 'OK' } }, event: { clearInstanceListeners: vi.fn() } },
  });
}

function Campo(): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const { apiError } = useGooglePlacesAutocomplete({ inputRef, onPlaceApplied: () => undefined });
  return (<><input ref={inputRef} /><span data-testid="aviso">{apiError ?? ''}</span></>);
}

async function assentar(ms = 50): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

beforeEach(() => {
  document.querySelectorAll('script[src*="maps.googleapis.com"]').forEach((s) => s.remove());
  delete (window as JanelaComGoogleAuth).gm_authFailure;
  stubGoogle();
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'chave-de-teste');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('useGooglePlacesAutocomplete — a chave recusada pelo Google', () => {
  it('CONTROLE POSITIVO: sem recusa, nenhum aviso — e o hook registrou o handler', async () => {
    render(<Campo />);
    await assentar();
    expect(screen.getByTestId('aviso')).toHaveTextContent('');
    expect(typeof (window as JanelaComGoogleAuth).gm_authFailure).toBe('function');
  });

  it('a recusa DEPOIS do widget pronto acende o aviso — o caminho que o loader não vê', async () => {
    render(<Campo />);
    await assentar();
    expect(screen.getByTestId('aviso')).toHaveTextContent('');

    await act(async () => { (window as JanelaComGoogleAuth).gm_authFailure?.(); });

    expect(screen.getByTestId('aviso')).toHaveTextContent('recusou esta aplicação');
  });

  it('campo montado DEPOIS da recusa também avisa: a falha vale para a página, não para a montagem', async () => {
    // Abrir outro drawer depois do erro não pode "zerar" o problema.
    render(<Campo />);
    await assentar();
    await act(async () => { (window as JanelaComGoogleAuth).gm_authFailure?.(); });

    render(<Campo />);
    await assentar();
    const avisos = screen.getAllByTestId('aviso');
    expect(avisos).toHaveLength(2);
    avisos.forEach((a) => expect(a).toHaveTextContent('recusou esta aplicação'));
  });

  it('não sequestra um `gm_authFailure` que já existia', async () => {
    const deTerceiro = vi.fn();
    (window as JanelaComGoogleAuth).gm_authFailure = deTerceiro;
    render(<Campo />);
    await assentar();
    expect((window as JanelaComGoogleAuth).gm_authFailure).toBe(deTerceiro);
  });
});
