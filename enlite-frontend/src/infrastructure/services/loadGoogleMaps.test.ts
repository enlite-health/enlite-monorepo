/**
 * O `<script>` que este carregador realmente injeta.
 *
 * A guarda do `googleMapsScriptUrl` prova que só existe UMA construção da URL;
 * este arquivo prova que é ela que chega ao DOM — inclusive com `geometry`, sem
 * a qual o traçado da rota não desenha e ninguém é avisado (o gancho desiste em
 * silêncio). Antes disso a linha do `src` estava descoberta, e o gate mediu:
 * apagar `geometry` deixava a suíte inteira verde com a feature morta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const CHAVE = 'CHAVE-DE-TESTE';

async function carregarModulo(): Promise<typeof import('./loadGoogleMaps')> {
  vi.resetModules(); // o `loadingPromise` é estado de módulo — sem isto, o 2º teste reusa o 1º
  return import('./loadGoogleMaps');
}

beforeEach(() => {
  document.head.innerHTML = '';
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', CHAVE);
  delete (window as { google?: unknown }).google;
});

describe('loadGoogleMaps', () => {
  it('injeta UM script, com `geometry` e a chave do ambiente', async () => {
    const { loadGoogleMaps } = await carregarModulo();
    void loadGoogleMaps();

    const scripts = document.head.querySelectorAll<HTMLScriptElement>('script[src*="maps.googleapis.com"]');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toContain('libraries=places,geometry');
    expect(scripts[0].src).toContain(`key=${CHAVE}`);
    expect(scripts[0].async).toBe(true);
  });

  it('resolve quando o script carrega, sem injetar um segundo', async () => {
    const { loadGoogleMaps } = await carregarModulo();
    const pendente = loadGoogleMaps();
    const script = document.head.querySelector<HTMLScriptElement>('script')!;

    script.onload?.(new Event('load'));
    await expect(pendente).resolves.toBeUndefined();
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
  });

  it('duas chamadas compartilham o MESMO script — é um carregador single-flight', async () => {
    const { loadGoogleMaps } = await carregarModulo();
    void loadGoogleMaps();
    void loadGoogleMaps();

    expect(document.head.querySelectorAll('script[src*="maps.googleapis.com"]')).toHaveLength(1);
  });

  it('sem chave configurada, rejeita e NÃO injeta nada', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    const { loadGoogleMaps } = await carregarModulo();

    await expect(loadGoogleMaps()).rejects.toThrow(/not configured/);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('com a chave-espaço-reservado, também rejeita', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'TODO_GOOGLE_MAPS_API_KEY');
    const { loadGoogleMaps } = await carregarModulo();

    await expect(loadGoogleMaps()).rejects.toThrow(/not configured/);
  });

  it('erro ao carregar rejeita e LIBERA o carregador para tentar de novo', async () => {
    const { loadGoogleMaps } = await carregarModulo();
    const primeira = loadGoogleMaps();
    document.head.querySelector<HTMLScriptElement>('script')!.onerror?.(new Event('error'));
    await expect(primeira).rejects.toThrow(/Failed to load/);

    // sem liberar, a tela ficaria sem mapa até um F5 — o segundo pedido tem de
    // poder injetar de novo
    document.head.innerHTML = '';
    void loadGoogleMaps();
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
  });

  it('script JÁ no DOM (outra tela subiu antes): reaproveita em vez de injetar outro', async () => {
    // Este é o caminho que torna a URL única indispensável: se outra tela
    // carregou o script primeiro, é a URL DELA que vale — daí a guarda de que
    // só existe uma construção.
    const antes = document.createElement('script');
    antes.src = 'https://maps.googleapis.com/maps/api/js?key=OUTRA&libraries=places,geometry&language=es';
    document.head.appendChild(antes);

    const { loadGoogleMaps } = await carregarModulo();
    const pendente = loadGoogleMaps();

    expect(document.head.querySelectorAll('script[src*="maps.googleapis.com"]')).toHaveLength(1);
    antes.dispatchEvent(new Event('load'));
    await expect(pendente).resolves.toBeUndefined();
  });

  it('script já no DOM que FALHA: rejeita e libera o carregador', async () => {
    const antes = document.createElement('script');
    antes.src = 'https://maps.googleapis.com/maps/api/js?key=OUTRA&libraries=places,geometry&language=es';
    document.head.appendChild(antes);

    const { loadGoogleMaps } = await carregarModulo();
    const pendente = loadGoogleMaps();
    antes.dispatchEvent(new Event('error'));

    await expect(pendente).rejects.toThrow(/Failed to load/);
  });

  it('se o `google.maps` já existe, resolve sem tocar no DOM', async () => {
    (window as { google?: unknown }).google = { maps: {} };
    const { loadGoogleMaps } = await carregarModulo();

    await expect(loadGoogleMaps()).resolves.toBeUndefined();
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });
});
