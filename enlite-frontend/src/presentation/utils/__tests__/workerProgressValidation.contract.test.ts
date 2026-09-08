import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_TOKENS, destinationFor } from '../incompleteFieldDestinations';

/**
 * TESTE DE CONTRATO — a única régua que atravessa a costura frontend × banco.
 *
 * Por que existe (incidente 08/09/2026): "cadastro completo" estava definido em
 * SETE lugares. A cópia do frontend omitia `phone` e `title_certificate`, então
 * a tela dizia "completo" e a postulação era recusada com "registro incompleto"
 * — 23 prestadoras nesse estado, medido em produção. Toda a suíte estava verde:
 * cada cópia passava no próprio teste, porque nenhuma estava errada SOZINHA. O
 * erro só existia ENTRE elas, e não havia teste entre elas.
 *
 * Este teste lê os tokens direto do corpo de `fn_worker_missing_fields` na
 * migration mais recente que a define — a MESMA função que o backend executa
 * para decidir se a postulação passa. Se alguém acrescentar um campo ao portão
 * sem dar destino a ele no frontend, ou remover um que o frontend ainda espera,
 * o build fica vermelho ANTES de virar gente travada.
 *
 * Se este teste falhar, NÃO edite a lista esperada: ajuste
 * `FIELD_DESTINATION_MAP` em `incompleteFieldDestinations.ts` para refletir o
 * portão. A verdade é a função no banco.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../../worker-functions/migrations');
const FN_NAME = 'fn_worker_missing_fields';

/** Tokens que a função devolve mas que NÃO são campo de formulário. */
const NON_FIELD_TOKENS = new Set(['worker_not_found']);

/**
 * Acha a migration mais recente (maior prefixo numérico) que redefine a função,
 * porque é ela que está viva no banco.
 */
function latestMigrationDefining(fnName: string): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ f, n: Number.parseInt(f.split('_')[0], 10) }))
    .filter(({ n }) => Number.isFinite(n))
    .sort((a, b) => b.n - a.n);

  for (const { f } of candidates) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    if (new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION[^;]*?${fnName}\\s*\\(`, 'i').test(sql)) {
      return { file: f, sql };
    }
  }
  throw new Error(`Nenhuma migration define ${fnName} — o instrumento está cego, não aprovado.`);
}

/** Extrai os tokens que a função pode acrescentar ao array de faltantes. */
function tokensFromFunction(sql: string): string[] {
  const found = [...sql.matchAll(/array_append\(\s*v_missing\s*,\s*'([a-z_]+)'\s*\)/g)].map(
    (m) => m[1],
  );
  return [...new Set(found)].sort();
}

describe('CONTRATO: campos do portão de REGISTERED (banco) × mapa do frontend', () => {
  const { file, sql } = latestMigrationDefining(FN_NAME);
  const backendTokens = tokensFromFunction(sql).filter((t) => !NON_FIELD_TOKENS.has(t));

  it('o instrumento enxerga: a migration viva declara tokens (zero seria cegueira, não sucesso)', () => {
    // Contagem zero é falha, nunca sucesso — se o regex parar de casar por uma
    // mudança de estilo no SQL, este teste acusa em vez de aprovar em silêncio.
    expect(file).toMatch(/\.sql$/);
    expect(backendTokens.length).toBeGreaterThanOrEqual(15);
  });

  it('todo campo que o portão exige tem destino no frontend', () => {
    const semDestino = backendTokens.filter((t) => !KNOWN_TOKENS.includes(t));
    expect(
      semDestino,
      `Campos exigidos por ${FN_NAME} (${file}) sem destino em FIELD_DESTINATION_MAP. ` +
        'A prestadora veria "cadastro completo" e levaria "registro incompleto" ao postular. ' +
        'Conserto: mapear em incompleteFieldDestinations.ts.',
    ).toEqual([]);
  });

  it('o frontend não espera campo que o portão não exige mais', () => {
    const orfaos = KNOWN_TOKENS.filter(
      (t) => !t.startsWith('doc_') && !backendTokens.includes(t),
    );
    expect(
      orfaos,
      `Tokens no FIELD_DESTINATION_MAP que ${FN_NAME} (${file}) não devolve mais. ` +
        'O frontend cobraria um campo que o portão já não pede.',
    ).toEqual([]);
  });

  it('todo destino aponta para uma aba que existe', () => {
    const abasValidas = new Set(['general', 'address', 'availability', 'documents']);
    for (const token of KNOWN_TOKENS) {
      expect(abasValidas.has(destinationFor(token).tab), `token ${token}`).toBe(true);
    }
  });

  it('os dois campos que causaram o incidente estão cobertos', () => {
    // Regressão nominal: `phone` e `title_certificate` eram exigidos pelo portão
    // e ignorados pela lista do frontend. 21 das 23 pessoas travadas eram
    // `title_certificate`.
    expect(backendTokens).toContain('phone');
    expect(backendTokens).toContain('title_certificate');
    expect(KNOWN_TOKENS).toContain('phone');
    expect(KNOWN_TOKENS).toContain('title_certificate');
  });
});
