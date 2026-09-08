import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fixture from '../../../test/fixtures/feature-catalog.json';
import { SCREEN_FEATURE_MAP } from '../screenFeatureMap';

const CHAVES_SCREEN = fixture.keys.filter((k) => k.startsWith('screen:'));

// ── B1 (D268): paridade mapa × App.tsx × adminNavigation.tsx ───────────────
// Lidos como TEXTO (não import) — o mesmo espírito de `ui-gate-debt.test.ts`:
// a prova é sobre o código real, não sobre uma cópia do que o mapa acha que é.

const APP_TSX = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');
const ADMIN_NAV_TSX = readFileSync(resolve(__dirname, '../adminNavigation.tsx'), 'utf8');

/** O bloco das rotas ANINHADAS sob `<Route path="/admin" ...>` — uma linha por `<Route .../>`. */
const INICIO_BLOCO_ADMIN = APP_TSX.indexOf('<Route index element={<AdminUsersPage />} />');
const FIM_BLOCO_ADMIN = APP_TSX.indexOf('{/* Catch-all: rota desconhecida');
if (INICIO_BLOCO_ADMIN === -1 || FIM_BLOCO_ADMIN === -1) {
  throw new Error('screenFeatureMap.test.ts: âncoras do bloco /admin não encontradas em App.tsx — o arquivo mudou, atualizar as âncoras.');
}
const BLOCO_ADMIN = APP_TSX.slice(INICIO_BLOCO_ADMIN, FIM_BLOCO_ADMIN);

interface RotaAdmin {
  /** Path relativo (sem `/admin/` na frente), '' para a rota `index`. */
  path: string;
  /** `feature="screen:x"` na mesma linha, ou null se a rota não está envolvida por FeatureRouteGate. */
  feature: string | null;
}

const ROTAS_ADMIN: RotaAdmin[] = BLOCO_ADMIN.split('\n')
  .map((linha): RotaAdmin | null => {
    if (/<Route\s+index\s+element/.test(linha)) return { path: '', feature: null };
    const pathM = linha.match(/<Route\s+path="([^"]+)"/);
    if (!pathM) return null;
    const featureM = linha.match(/feature="([^"]+)"/);
    return { path: pathM[1], feature: featureM ? featureM[1] : null };
  })
  .filter((r): r is RotaAdmin => r !== null);

/** Rotas `/admin/*` que de propósito NÃO têm chave `screen:*` (comentário em App.tsx confirma). */
// Sync main→stage (06/09): mapa, mensagens por etapa, plantillas e invitación também não têm
// chave `screen:*` no manifest — gateadas por célula (`messaging:read` no menu), não por país.
const ROTAS_SEM_CHAVE_SCREEN = new Set([
  '', 'tags', 'patient-chat-roles', 'dedup', 'api-docs',
  'mapa', 'mensajes-por-etapa', 'plantillas', 'plantillas/registrar', 'plantillas/:slug', 'invitacion-presentacion',
  // Spec 017: os 3 catálogos do projeto terapêutico — gateados pela célula própria de cada um, não por país.
  'catalogos/objetivos-especificos', 'catalogos/actividades', 'catalogos/tipos-de-patologia',
]);

/** Todo `href: '...'` literal declarado em `adminNavigation.tsx` (baseItems + adminItems + accessItems). */
const HREFS_NO_MENU = new Set([...ADMIN_NAV_TSX.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]));

describe('SCREEN_FEATURE_MAP — as 8 chaves screen:* do manifest (B2/D268)', () => {
  it('a fixture tem exatamente as 8 chaves screen:* esperadas', () => {
    expect(CHAVES_SCREEN).toEqual([
      'screen:access-permissions',
      'screen:ana-care',
      'screen:funnel',
      'screen:management-dashboard',
      'screen:patients',
      'screen:talentum',
      'screen:vacancies',
      'screen:workers',
    ]);
  });

  it.each(CHAVES_SCREEN)('%s tem entrada no mapa', (chave) => {
    expect(SCREEN_FEATURE_MAP[chave]).toBeDefined();
  });

  it('toda entrada do mapa tem `routes` (array, mesmo que vazio) — nunca ausente', () => {
    for (const [chave, entrada] of Object.entries(SCREEN_FEATURE_MAP)) {
      expect(Array.isArray(entrada.routes), `${chave} sem routes[]`).toBe(true);
    }
  });

  it('screen:ana-care não tem rota nem item — `semConsumidorHoje` explícito, routes vazio', () => {
    const anaCare = SCREEN_FEATURE_MAP['screen:ana-care'];
    expect(anaCare.routes).toEqual([]);
    expect(anaCare.navHref).toBeUndefined();
    expect(anaCare.semConsumidorHoje).toBeTruthy();
  });

  it('screen:talentum não tem item de menu de topo (rota aninhada), mas tem rota', () => {
    const talentum = SCREEN_FEATURE_MAP['screen:talentum'];
    expect(talentum.navHref).toBeUndefined();
    expect(talentum.routes.length).toBeGreaterThan(0);
  });

  it('as demais 6 chaves com tela hoje têm navHref e ao menos 1 rota', () => {
    const comTela = CHAVES_SCREEN.filter((k) => k !== 'screen:ana-care' && k !== 'screen:talentum');
    for (const chave of comTela) {
      const entrada = SCREEN_FEATURE_MAP[chave];
      expect(entrada.navHref, `${chave} sem navHref`).toBeTruthy();
      expect(entrada.routes.length, `${chave} sem routes`).toBeGreaterThan(0);
    }
  });

  it('o mapa não tem chave a mais que não exista na fixture (evita lixo/typo)', () => {
    for (const chave of Object.keys(SCREEN_FEATURE_MAP)) {
      expect(fixture.keys, `${chave} não existe no manifest`).toContain(chave);
    }
  });

  it('sanity: a extração de App.tsx achou rota — senão a régua abaixo não mede nada', () => {
    expect(ROTAS_ADMIN.length).toBeGreaterThan(0);
  });

  it('🔴 toda rota /admin em App.tsx tem FeatureRouteGate + está no mapa — OU está na lista de exceção conhecida', () => {
    const problemas: string[] = [];
    for (const rota of ROTAS_ADMIN) {
      if (ROTAS_SEM_CHAVE_SCREEN.has(rota.path)) continue;
      const fullPath = `/admin/${rota.path}`;
      if (!rota.feature) {
        problemas.push(`${fullPath}: rota admin nova sem FeatureRouteGate e fora da lista de exceção (ROTAS_SEM_CHAVE_SCREEN)`);
        continue;
      }
      const entrada = SCREEN_FEATURE_MAP[rota.feature];
      if (!entrada) {
        problemas.push(`${fullPath}: feature="${rota.feature}" não existe em SCREEN_FEATURE_MAP`);
        continue;
      }
      if (!entrada.routes.includes(fullPath)) {
        problemas.push(`${fullPath}: gateada por "${rota.feature}" em App.tsx, mas ausente de SCREEN_FEATURE_MAP['${rota.feature}'].routes`);
      }
    }
    expect(problemas, JSON.stringify(problemas, null, 2)).toEqual([]);
  });

  it('🔴 toda rota listada em SCREEN_FEATURE_MAP[chave].routes existe de fato em App.tsx, gateada pela MESMA chave', () => {
    const rotaParaFeature = new Map(ROTAS_ADMIN.filter((r) => r.feature).map((r) => [`/admin/${r.path}`, r.feature]));
    const problemas: string[] = [];
    for (const [chave, entrada] of Object.entries(SCREEN_FEATURE_MAP)) {
      for (const rota of entrada.routes) {
        if (rotaParaFeature.get(rota) !== chave) {
          problemas.push(`${rota}: SCREEN_FEATURE_MAP['${chave}'] promete esta rota, mas App.tsx não tem <Route> com FeatureRouteGate feature="${chave}" nela`);
        }
      }
    }
    expect(problemas, JSON.stringify(problemas, null, 2)).toEqual([]);
  });

  it('🔴 todo navHref do mapa existe como `href:` de item em adminNavigation.tsx', () => {
    const problemas: string[] = [];
    for (const [chave, entrada] of Object.entries(SCREEN_FEATURE_MAP)) {
      if (!entrada.navHref) continue;
      if (!HREFS_NO_MENU.has(entrada.navHref)) {
        problemas.push(`${chave}: navHref '${entrada.navHref}' não existe como href de item em adminNavigation.tsx`);
      }
    }
    expect(problemas, JSON.stringify(problemas, null, 2)).toEqual([]);
  });
});
