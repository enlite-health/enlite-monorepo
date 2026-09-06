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
    // Arquivo de TESTE fica de fora: ele usa a URL como fixture (para simular um
    // script já no DOM) e não carrega nada em produção. Sem esta exceção a
    // guarda reprova o teste do próprio carregador — falso positivo, e guarda
    // que reprova código certo se aprende a ignorar.
    const infratores = arquivos(SRC)
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith('googleMapsScriptUrl.ts'))
      .filter((f) => readFileSync(f, 'utf-8').includes('maps/api/js?key='));

    expect(infratores.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('a guarda está de fato varrendo arquivos (contagem zero não é aprovação)', () => {
    const todos = arquivos(SRC);
    expect(todos.length).toBeGreaterThan(200);
    expect(todos.some((f) => f.endsWith('loadGoogleMaps.ts'))).toBe(true);
  });
});
