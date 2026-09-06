/**
 * assertLocalDatabaseTarget.test.ts — o teste que faltava para a trava de alvo.
 *
 * 🔴 POR QUE ELE EXISTE (gate F5, D2): o cabeçalho do próprio módulo diz "uma trava só vale
 * medida… Trava sem teste que a exercite é declaração" — e o módulo NÃO tinha teste dedicado.
 * Medido antes deste arquivo (`jest --coverage` sobre os 2 únicos consumidores que a tocavam):
 *
 *     assertLocalDatabaseTarget.ts | 91.66 stmts | 78.57 branch | 100 funcs | 91.3 lines | 62,80
 *
 * A linha 62 é o `throw` da guarda anti-Cloud-SQL (`DB_HOST=/cloudsql/...`): a trava que MAIS
 * importa nunca tinha sido exercitada — ela existia como declaração. A 80 é a recusa de URL
 * inválida. As duas entram aqui.
 *
 * 🔒 CONTROLE NEGATIVO OBRIGATÓRIO: um instrumento que só reprova aprende a ser ignorado. Cada
 * bloco tem os alvos LEGÍTIMOS que TÊM de passar — se a trava passar a recusar tudo, estes
 * quebram.
 *
 * 🔒 RÉGUA POSITIVA (mesma disciplina de `ingest-icd11-catalog.trava.test.ts`): cada recusa
 * afirma a MENSAGEM, não só "lançou". `expect(...).toThrow()` fica verde com a trava MORTA
 * (import errado ⇒ ReferenceError ⇒ "lançou" é verdade pelo motivo errado).
 */
import {
  assertBackfillWriteTarget,
  assertLocalDatabaseTarget,
  LOCAL_DB_HOSTS,
  LOCAL_DB_PORTS,
  LOCAL_DB_NAME,
} from '../assertLocalDatabaseTarget';

const DB_HOST_ORIGINAL = process.env.DB_HOST;

afterEach(() => {
  if (DB_HOST_ORIGINAL === undefined) delete process.env.DB_HOST;
  else process.env.DB_HOST = DB_HOST_ORIGINAL;
});

/** Captura o erro sem confiar em `toThrow` — é o que permite afirmar tipo E mensagem. */
function recusa(url: string | undefined): Error {
  try {
    assertLocalDatabaseTarget(url);
  } catch (e) {
    return e as Error;
  }
  throw new Error(`ACEITOU o alvo ${JSON.stringify(url)} — deveria ter recusado`);
}

describe('assertLocalDatabaseTarget — CONTROLE NEGATIVO: o que TEM de passar', () => {
  it('aceita o docker local padrão e devolve host:porta/base', () => {
    expect(assertLocalDatabaseTarget('postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e'))
      .toBe('localhost:5432/enlite_e2e');
  });

  it.each(LOCAL_DB_HOSTS.filter(h => h !== '::1'))('aceita o host local "%s"', host => {
    expect(assertLocalDatabaseTarget(`postgresql://u:p@${host}:5433/${LOCAL_DB_NAME}`))
      .toBe(`${host}:5433/${LOCAL_DB_NAME}`);
  });

  it.each(LOCAL_DB_PORTS)('aceita a porta local %s', porta => {
    expect(assertLocalDatabaseTarget(`postgresql://u:p@localhost:${porta}/${LOCAL_DB_NAME}`))
      .toBe(`localhost:${porta}/${LOCAL_DB_NAME}`);
  });

  it('aceita URL sem porta explícita — o default do pg é 5432, que é local', () => {
    expect(assertLocalDatabaseTarget(`postgresql://u:p@localhost/${LOCAL_DB_NAME}`))
      .toBe(`localhost:5432/${LOCAL_DB_NAME}`);
  });

  it('não depende de DB_HOST quando ele NÃO é socket do Cloud SQL', () => {
    process.env.DB_HOST = 'localhost';
    expect(assertLocalDatabaseTarget(`postgresql://u:p@localhost:5432/${LOCAL_DB_NAME}`))
      .toBe(`localhost:5432/${LOCAL_DB_NAME}`);
  });
});

describe('assertLocalDatabaseTarget — as recusas, cada uma pela mensagem certa', () => {
  it('RECUSA alvo ausente — ausência nunca é "local"', () => {
    expect(recusa(undefined).message).toMatch(/^TRAVA: DATABASE_URL não definido/);
    expect(recusa('').message).toMatch(/^TRAVA: DATABASE_URL não definido/);
  });

  // ── linha 62: a guarda que NUNCA tinha sido exercitada ────────────────────────────────────
  it('RECUSA quando DB_HOST aponta para socket /cloudsql/ — isso é Cloud SQL de PRODUÇÃO', () => {
    process.env.DB_HOST = '/cloudsql/enlite-prd:southamerica-east1:enlite-ar';
    const e = recusa(`postgresql://u:p@localhost:5432/${LOCAL_DB_NAME}`);
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.message).toBe('TRAVA: DB_HOST aponta para socket /cloudsql/ — isso é Cloud SQL. Recusado.');
  });

  it('a guarda de DB_HOST vence ANTES da lista de permissão — nem a URL mais local passa', () => {
    process.env.DB_HOST = '/cloudsql/qualquer:coisa:aqui';
    expect(recusa('postgresql://enlite_admin:enlite_password@127.0.0.1:5432/enlite_e2e').message)
      .toMatch(/^TRAVA: DB_HOST aponta para socket/);
  });

  // ── camada (2): query string ──────────────────────────────────────────────────────────────
  it('RECUSA "?port=5436" — o parâmetro VENCE a autoridade da URL para quem conecta (PRD)', () => {
    expect(recusa('postgresql://u:p@localhost:5432/enlite_e2e?port=5436').message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA "?host=/cloudsql/..." — a URL parece local e o pg conecta no Cloud SQL', () => {
    expect(recusa('postgresql://u:p@localhost:5432/enlite_e2e?host=/cloudsql/enlite-prd:southamerica-east1:enlite-ar').message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA qualquer query string, mesmo inócua — a regra é de FORMA, não de conteúdo', () => {
    expect(recusa(`postgresql://u:p@localhost:5432/${LOCAL_DB_NAME}?sslmode=disable`).message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('PROVA da divergência: o pg lê "?port=5436" como 5436, e é por isso que a forma é recusada', () => {
    // Sem esta asserção o teste acima seria "a trava recusa porque sim". Aqui o motivo é MEDIDO
    // contra o parser de quem conecta: o mesmo `pg-connection-string` que o `pg.Pool` usa.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require('pg-connection-string') as { parse: (s: string) => { port?: string | null } };
    expect(String(parse('postgresql://u:p@localhost:5432/enlite_e2e?port=5436').port)).toBe('5436');
  });

  // ── linha 80: URL que o parser de quem conecta não consegue ler ────────────────────────────
  it('RECUSA URL inválida SEM tentar conectar — não adivinha o que o parser não leu', () => {
    const e = recusa('postgresql://[::1:5432/enlite_e2e');
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e.message).toBe('TRAVA: DATABASE_URL não é uma URL válida — recusado sem tentar conectar.');
  });

  // ── camada (1): a lista de PERMISSÃO ──────────────────────────────────────────────────────
  it('RECUSA a porta de PRD (5436) nomeando a porta barrada', () => {
    expect(recusa('postgresql://u:p@localhost:5436/enlite_e2e').message).toMatch(/^TRAVA: porta 5436 /);
  });

  it('RECUSA a porta de stage (5434)', () => {
    expect(recusa('postgresql://u:p@localhost:5434/enlite_e2e').message).toMatch(/^TRAVA: porta 5434 /);
  });

  it('RECUSA a porta da réplica local de PRD (5437) — "local" não basta, a porta tem de estar na lista', () => {
    expect(recusa('postgresql://u:p@localhost:5437/enlite_e2e').message).toMatch(/^TRAVA: porta 5437 /);
  });

  it('RECUSA host remoto nomeando o host', () => {
    expect(recusa('postgresql://u:p@10.0.0.5:5432/enlite_e2e').message)
      .toBe(`TRAVA: host "10.0.0.5" não é local. Permitidos: ${LOCAL_DB_HOSTS.join(', ')}.`);
  });

  it('RECUSA base fora da lista — mesmo em host e porta locais', () => {
    expect(recusa('postgresql://u:p@localhost:5432/enlite_ar').message)
      .toBe(`TRAVA: base "enlite_ar" não é "${LOCAL_DB_NAME}".`);
  });

  it('RECUSA base ausente', () => {
    expect(recusa('postgresql://u:p@localhost:5432').message).toMatch(/^TRAVA: base ""/);
  });

  it('nenhuma recusa é ReferenceError — a trava tem de estar VIVA, não quebrada', () => {
    for (const url of [
      'postgresql://u:p@localhost:5436/enlite_e2e',
      'postgresql://u:p@10.0.0.5:5432/enlite_e2e',
      'postgresql://u:p@localhost:5432/enlite_ar',
      'postgresql://u:p@localhost:5432/enlite_e2e?port=5436',
    ]) {
      const e = recusa(url);
      expect(e).not.toBeInstanceOf(ReferenceError);
      expect(e.message).toMatch(/^TRAVA: /);
    }
  });
});

/**
 * ── A variante dos backfills ────────────────────────────────────────────────────────────────
 *
 * Mesma régua de alvo, consequência diferente: existe um caminho legítimo fora do docker local,
 * atrás de `--eu-sei-que-e-producao`. O que este bloco mede é que o flag amplia a lista de
 * ALVOS e NADA MAIS — em particular, que ele não desarma as guardas de FORMA (query string e
 * socket `/cloudsql/`), que são justamente as que a cópia local dos 3 backfills não tinha.
 */
describe('assertBackfillWriteTarget — o flag amplia o ALVO, nunca a FORMA', () => {
  function recusaBackfill(url: string | undefined, prodOk: boolean): Error {
    try {
      const alvo = assertBackfillWriteTarget(url, prodOk);
      throw new Error(`ACEITOU ${JSON.stringify(url)} como ${JSON.stringify(alvo)} — deveria ter recusado`);
    } catch (e) {
      const err = e as Error;
      if (err.message.startsWith('ACEITOU ')) throw err;
      return err;
    }
  }

  it('CONTROLE NEGATIVO: o docker local passa sem flag nenhum', () => {
    expect(assertBackfillWriteTarget(`postgresql://u:p@localhost:5432/${LOCAL_DB_NAME}`, false)).toBe('LOCAL (docker)');
  });

  it('CONTROLE NEGATIVO: o docker local passa TAMBÉM com o flag — o flag não muda o que já é local', () => {
    expect(assertBackfillWriteTarget(`postgresql://u:p@127.0.0.1:5433/${LOCAL_DB_NAME}`, true)).toBe('LOCAL (docker)');
  });

  it('CONTROLE NEGATIVO: alvo não-local COM o flag é autorizado — o caminho legítimo de produção', () => {
    expect(assertBackfillWriteTarget('postgresql://u:p@10.0.0.5:5432/enlite_ar', true))
      .toBe('NÃO-LOCAL, autorizado explicitamente');
  });

  it('RECUSA alvo não-local SEM o flag, e a mensagem carrega o MOTIVO da recusa de alvo', () => {
    const e = recusaBackfill('postgresql://u:p@localhost:5436/enlite_ar', false);
    expect(e.message).toMatch(/^ALVO RECUSADO: este script escreve em linha de paciente\./);
    expect(e.message).toMatch(/--eu-sei-que-e-producao/);
    expect(e.message).toMatch(/Motivo: TRAVA: porta 5436 /);
  });

  it('RECUSA "?port=5436" COM o flag — o flag não pode ser satisfeito por query string', () => {
    expect(recusaBackfill('postgresql://u:p@localhost:5432/enlite_e2e?port=5436', true).message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA "?host=/cloudsql/…" COM o flag', () => {
    expect(recusaBackfill('postgresql://u:p@localhost:5432/enlite_e2e?host=/cloudsql/enlite-prd:x:y', true).message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA DB_HOST de socket /cloudsql/ COM o flag', () => {
    process.env.DB_HOST = '/cloudsql/enlite-prd:southamerica-east1:enlite-ar';
    expect(recusaBackfill(`postgresql://u:p@localhost:5432/${LOCAL_DB_NAME}`, true).message)
      .toMatch(/^TRAVA: DB_HOST aponta para socket/);
  });

  it('RECUSA alvo ausente COM o flag — autorizar produção não inventa alvo', () => {
    expect(recusaBackfill(undefined, true).message).toMatch(/^TRAVA: DATABASE_URL não definido/);
  });

  it('RECUSA URL ilegível COM o flag — o que o parser não leu não é "alvo autorizado"', () => {
    expect(recusaBackfill('postgresql://[::1:5432/enlite_e2e', true).message)
      .toBe('TRAVA: DATABASE_URL não é uma URL válida — recusado sem tentar conectar.');
  });

  it('LEITURA DE SOCKET UNIX: caminho sem porta nem base cai na régua de host, não em exceção', () => {
    // `/var/run/postgresql` é o formato de socket do próprio `pg-connection-string` (porta e
    // base ausentes). Sem o flag ele é recusado como qualquer outro alvo fora da lista.
    expect(recusaBackfill('/var/run/postgresql', false).message)
      .toMatch(/Motivo: TRAVA: host "\/var\/run\/postgresql" não é local/);
  });
});
