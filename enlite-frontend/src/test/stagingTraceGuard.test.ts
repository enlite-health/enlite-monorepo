/**
 * Guarda estática: o trace do Playwright de staging não pode virar depósito de
 * geometria de domicílio.
 *
 * Condição C6 do parecer do `lex` (06/09). `playwright.staging.config.ts` roda
 * com `trace: 'on'`, e o trace do Playwright guarda CORPO DE RESPOSTA. A
 * resposta de `/api/admin/map/corridor` passou a carregar a polilinha porta a
 * porta, cujos vértices das pontas são dois domicílios — e a massa da `stage` é
 * derivada de produção (a identidade é sintética, mas ninguém verificou que a
 * COORDENADA também é).
 *
 * Hoje o journey de staging não abre o mapa, então não há problema. Esta guarda
 * existe porque "não há problema hoje" é a frase que antecede o vazamento: quem
 * acrescentar um passo de mapa àquele journey daqui a seis meses não vai ler
 * este parecer. O teste é que vai contar.
 *
 * Como reagir se este teste ficar vermelho: NÃO apague a asserção. Ou tire o
 * trecho de mapa do journey de staging, ou mude aquele projeto para
 * `trace: 'off'` (ou `retain-on-failure` com purga), ou traga a evidência de
 * que a coordenada da `stage` é sintética — e então relaxe a regra citando-a.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ler = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

/** O que denuncia que o journey encostou no corredor. */
const PEGADAS = ['/admin/mapa', 'map/corridor', 'corridor-panel', 'points-map'];

describe('trace de staging × geometria de domicílio (C6)', () => {
  it('o journey de staging não toca o mapa enquanto o trace estiver ligado', () => {
    const config = ler('playwright.staging.config.ts');
    const traceLigado = /trace:\s*'on'/.test(config);

    // Se alguém já desligou o trace, a guarda não tem o que proteger.
    if (!traceLigado) return;

    const journey = ler('e2e/staging-journey-clean.e2e.ts');
    const encontradas = PEGADAS.filter((p) => journey.includes(p));

    expect(encontradas).toEqual([]);
  });

  it('a guarda está apontando para os arquivos certos (senão ela é decorativa)', () => {
    // Contagem zero é falha, nunca sucesso: sem isto, renomear qualquer um dos
    // dois arquivos faria o teste acima passar lendo o vazio.
    expect(ler('playwright.staging.config.ts')).toContain('staging-journey-clean');
    expect(ler('e2e/staging-journey-clean.e2e.ts').length).toBeGreaterThan(500);
  });
});
