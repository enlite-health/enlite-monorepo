/**
 * A URL do script do Maps — e a guarda estrutural de que só existe UMA.
 *
 * O gate de 06/09/2026 mediu o buraco que este arquivo fecha: apagar `geometry`
 * das duas construções da URL deixava a suíte inteira verde (5.568 testes) com o
 * traçado da rota morto em produção, porque `useRouteOverlay` desiste em
 * silêncio quando `google.maps.geometry.encoding` não existe.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { googleMapsScriptUrl, GOOGLE_MAPS_LIBRARIES } from './googleMapsScriptUrl';

const SRC = resolve(__dirname, '../..');

/** Todo `.ts`/`.tsx` de `src/`, para a varredura da guarda. */
function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, saida);
    else if (/\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

describe('googleMapsScriptUrl', () => {
  it('pede `geometry` — sem ela o traçado da rota não desenha, e ninguém é avisado', () => {
    const url = googleMapsScriptUrl('CHAVE');

    expect(url).toContain('libraries=places,geometry');
    expect(GOOGLE_MAPS_LIBRARIES).toContain('geometry');
    expect(GOOGLE_MAPS_LIBRARIES).toContain('places'); // autocomplete do cadastro
  });

  it('monta a URL do Maps com a chave e o idioma do painel', () => {
    const url = googleMapsScriptUrl('CHAVE-123');

    expect(url).toBe('https://maps.googleapis.com/maps/api/js?key=CHAVE-123&libraries=places,geometry&language=es');
  });

  it('🔒 só EXISTE uma construção desta URL em todo o `src/`', () => {
    // Esta é a asserção que importa. O script do Maps carrega uma vez por
    // página e quem chega primeiro define as bibliotecas: um segundo lugar
    // montando a URL faria a biblioteca faltante sumir de forma INTERMITENTE,
    // conforme a tela aberta antes. Se este teste ficar vermelho, o conserto NÃO
    // é relaxar a busca — é fazer o arquivo novo importar `googleMapsScriptUrl`.
    //
    // ⚠️ A busca é pelo `//` do esquema + host + caminho, e cada pedaço tem
    // razão. Por `?key=` não serve: a primeira versão procurava
    // `maps/api/js?key=` e passava verde se alguém trocasse a ordem dos
    // parâmetros (`js?libraries=…&key=…`) — régua de FORMA que não media a
    // substância, medido no gate de 06/09. Por host puro também não: casaria o
    // SELETOR CSS de `loadGoogleMaps` (`script[src*="maps.googleapis.com/…"]`),
    // que procura o script no DOM em vez de montar URL. O `//` só aparece em
    // URL literal, e cobre também a forma sem esquema (`//maps.googleapis…`).
    //
    // A isenção é NOMINAL, e não um padrão `.test.`: com o padrão, um carregador
    // de produção escondido num arquivo com `.test.` no nome passava por aqui,
    // pelo `tsc` e pelo validador de arquitetura — também medido. Isenção por
    // nome obriga quem acrescentar a pensar; padrão largo isenta o que ninguém
    // previu.
    const ISENTOS = ['googleMapsScriptUrl.ts', 'googleMapsScriptUrl.test.ts', 'loadGoogleMaps.test.ts'];

    const infratores = arquivos(SRC)
      .filter((f) => !ISENTOS.some((nome) => f.endsWith(`/${nome}`)))
      .filter((f) => readFileSync(f, 'utf-8').includes('//maps.googleapis.com/maps/api/js'));

    expect(infratores.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('a guarda está de fato varrendo arquivos (contagem zero não é aprovação)', () => {
    const todos = arquivos(SRC);
    expect(todos.length).toBeGreaterThan(200);
    expect(todos.some((f) => f.endsWith('loadGoogleMaps.ts'))).toBe(true);
  });
});
