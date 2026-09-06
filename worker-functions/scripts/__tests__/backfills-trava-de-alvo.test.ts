/**
 * backfills-trava-de-alvo.test.ts — gate F5, D1 (o mais grave).
 *
 * 🔴 O DEFEITO QUE ESTE ARQUIVO EXPÕE: os três backfills que ESCREVEM em linha de paciente
 * tinham uma CÓPIA LOCAL da trava de alvo, com o regex terminando em `(\?|$)`. Consequência
 * MEDIDA (antes deste teste):
 *
 *   postgresql://…@localhost:5432/enlite_e2e?port=5436            → "LOCAL (docker)"  ⇒ pg conecta na 5436 (PRD)
 *   postgresql://…@localhost:5432/enlite_e2e?host=/cloudsql/…     → "LOCAL (docker)"  ⇒ pg conecta no Cloud SQL de PRODUÇÃO
 *
 * A cópia aprovava PRODUÇÃO. `assertLocalDatabaseTarget` (src/shared/database) já recusava as
 * duas formas desde a rodada 3 da 2.2 — a divergência é exatamente o preço de copiar em vez de
 * reusar, e é por isso que a régua aqui é a MESMA para os três scripts (uma tabela, não três
 * blocos): se um deles voltar a ter implementação própria, ele diverge e o teste acusa.
 *
 * 🔒 Régua POSITIVA: cada recusa afirma a MENSAGEM. `toThrow()` sozinho ficaria verde com a
 * trava morta (import errado ⇒ ReferenceError ⇒ "lançou" pelo motivo errado) — o modo de falha
 * já medido em `ingest-icd11-catalog.trava.test.ts`.
 */
import { travaDeAlvo as trava24 } from '../backfill-2.4-segmento-cru';
import { travaDeAlvo as trava3 } from '../backfill-3-cobertura';
import { travaDeAlvo as trava42 } from '../backfill-4.2-dispositivo';

const SCRIPTS: ReadonlyArray<[string, (url: string | undefined, prodOk: boolean) => string]> = [
  ['backfill-2.4-segmento-cru', trava24],
  ['backfill-3-cobertura', trava3],
  ['backfill-4.2-dispositivo', trava42],
];

const LOCAL = 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

function recusa(trava: (u: string | undefined, p: boolean) => string, url: string | undefined, prodOk = false): Error {
  try {
    const alvo = trava(url, prodOk);
    throw new Error(`ACEITOU ${JSON.stringify(url)} classificando-o como ${JSON.stringify(alvo)} — deveria ter recusado`);
  } catch (e) {
    const err = e as Error;
    if (err.message.startsWith('ACEITOU ')) throw err;
    return err;
  }
}

describe.each(SCRIPTS)('trava de alvo de %s', (_nome, trava) => {
  // ── CONTROLE NEGATIVO: o que TEM de continuar passando ──────────────────────────────────
  it('ACEITA o docker local — é para onde o backfill deve ir', () => {
    expect(trava(LOCAL, false)).toBe('LOCAL (docker)');
  });

  it('ACEITA 127.0.0.1 e a porta 5433', () => {
    expect(trava('postgresql://u:p@127.0.0.1:5433/enlite_e2e', false)).toBe('LOCAL (docker)');
  });

  it('ACEITA alvo não-local COM --eu-sei-que-e-producao — o flag preservado', () => {
    expect(trava('postgresql://u:p@10.0.0.5:5432/enlite_ar', true)).toBe('NÃO-LOCAL, autorizado explicitamente');
  });

  // ── O DEFEITO ───────────────────────────────────────────────────────────────────────────
  it('RECUSA "?port=5436" — o parâmetro VENCE a URL para o pg e a conexão vai para PRD', () => {
    const e = recusa(trava, 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e?port=5436');
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.message).toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA "?host=/cloudsql/…" — a URL parece local e o pg conecta no Cloud SQL de PRODUÇÃO', () => {
    const e = recusa(trava, 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e?host=/cloudsql/enlite-prd:southamerica-east1:enlite-ar');
    expect(e.message).toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('a query string NÃO é satisfeita nem por --eu-sei-que-e-producao — o flag não desarma a forma', () => {
    const e = recusa(trava, 'postgresql://u:p@localhost:5432/enlite_e2e?port=5436', true);
    expect(e.message).toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  // ── as recusas que a cópia já fazia, e que não podem regredir no conserto ────────────────
  it('RECUSA alvo ausente — ausência não é local', () => {
    expect(recusa(trava, undefined).message).toMatch(/^TRAVA: DATABASE_URL não definido/);
  });

  it('RECUSA a porta de PRD (5436) sem o flag, nomeando o motivo', () => {
    const e = recusa(trava, 'postgresql://u:p@localhost:5436/enlite_ar');
    expect(e.message).toMatch(/^ALVO RECUSADO: /);
    expect(e.message).toMatch(/--eu-sei-que-e-producao/);
  });

  it('RECUSA host remoto sem o flag', () => {
    expect(recusa(trava, 'postgresql://u:p@10.0.0.5:5432/enlite_e2e').message).toMatch(/^ALVO RECUSADO: /);
  });

  it('RECUSA DB_HOST de socket /cloudsql/ mesmo COM o flag — Cloud SQL nunca é alvo de backfill', () => {
    const antes = process.env.DB_HOST;
    process.env.DB_HOST = '/cloudsql/enlite-prd:southamerica-east1:enlite-ar';
    try {
      expect(recusa(trava, LOCAL, true).message).toMatch(/^TRAVA: DB_HOST aponta para socket/);
    } finally {
      if (antes === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = antes;
    }
  });
});

describe('a trava é UMA só — reuso, não cópia', () => {
  it('os três scripts apontam para a MESMA função (identidade, não comportamento parecido)', () => {
    expect(trava3).toBe(trava24);
    expect(trava42).toBe(trava24);
  });
});
