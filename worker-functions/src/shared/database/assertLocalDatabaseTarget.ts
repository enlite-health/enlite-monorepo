/**
 * assertLocalDatabaseTarget — a trava que separa "verificação local" de "escrita em produção".
 *
 * Task 2.2 da change `campos-admissao`. Existe porque há `cloud-sql-proxy` VIVO na máquina
 * de desenvolvimento: `localhost:5436` aponta para o Cloud SQL de PRODUÇÃO e `localhost:5434`
 * para o de stage. Um script de verificação que ESCREVE e que confia no `DATABASE_URL` do
 * ambiente está a uma variável de distância de escrever em produção — e "localhost" não
 * significa mais "local".
 *
 * Por que vive em `src/` e não ao lado do script que a usa: uma trava só vale medida, e o
 * que mora em `scripts/` fica fora do alcance da suíte (medido: o guardian monta a
 * árvore-sombra a partir de `src`, `tests`, `jest.config.js`, `tsconfig.json` e
 * `package.json` — `scripts/` não entra). Trava sem teste que a exercite é declaração.
 *
 * É lista de PERMISSÃO, nunca de bloqueio: host, porta e base têm de estar todos na lista.
 * Uma lista de bloqueio nasce desatualizada no dia em que abrirem o quarto proxy.
 *
 * ── DEFEITO 7 DO QA-CAÇA DA 2.2: A TRAVA LIA DIFERENTE DE QUEM CONECTA ───────
 * A versão anterior lia a URL com `new URL` e olhava `u.port`/`u.hostname`. Quem conecta
 * (`pg` → `pg-connection-string`) lê a MESMA string com outra regra: **o parâmetro de query
 * VENCE o que está na autoridade da URL**. Medido:
 *
 *     postgresql://u:p@localhost:5432/enlite_e2e?port=5436
 *       trava (antes): PASSOU, declarando localhost:5432/enlite_e2e
 *       pg:            host="localhost" port="5436"   ← PRODUÇÃO
 *
 *     postgresql://u:p@localhost:5432/enlite_e2e?host=/cloudsql/proj:region:inst
 *       trava (antes): PASSOU
 *       pg:            host="/cloudsql/proj:region:inst"
 *
 * Uma lista de permissão sobre uma leitura que NÃO é a leitura de quem consome aprova um
 * alvo e abre outro — e o único caso em que a trava seria a última linha de defesa é
 * justamente aquele em que ela erra. O conserto tem duas camadas, e as duas são baratas:
 *
 *   (1) **A trava lê com o parser de quem conecta.** `pg-connection-string.parse` é
 *       literalmente o que `pg.Pool({ connectionString })` usa para montar a conexão. O que
 *       é validado aqui passa a ser o `host`/`port`/`database` EFETIVOS.
 *   (2) **Query string é recusada de saída.** Nenhum `DATABASE_URL` deste repo usa uma
 *       (`.env.example`, `.env.test`, `package.json`: zero), e um alvo local nunca precisa
 *       de parâmetro. Recusar é o que mantém as duas leituras trivialmente idênticas mesmo
 *       que o parser mude de comportamento numa versão futura — a camada (1) sozinha ficaria
 *       refém do parser, e a (2) sozinha não cobriria formas que não são query string.
 */

import { parse as parseConnectionString } from 'pg-connection-string';

export const LOCAL_DB_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;
export const LOCAL_DB_PORTS = ['5432', '5433'] as const;
export const LOCAL_DB_NAME = 'enlite_e2e';

/** `null`/`undefined` viram string vazia — o parser tipa os três campos como opcionais. */
const texto = (v: string | null | undefined): string => (v == null ? '' : v);

/** O alvo EFETIVO, lido com o parser de quem conecta. */
interface AlvoLido {
  readonly host: string;
  readonly porta: string;
  readonly base: string;
}

/**
 * As guardas que NENHUM flag desarma — nem `--eu-sei-que-e-producao`. As duas recusam uma
 * FORMA de redirecionar a conexão para longe do que a URL aparenta, e por isso valem antes de
 * qualquer lista (de permissão ou de autorização).
 */
function assertSemRedirecionamento(url: string | undefined): asserts url is string {
  if (!url) throw new Error('TRAVA: DATABASE_URL não definido. Nada aqui adivinha alvo.');
  if (process.env.DB_HOST?.startsWith('/cloudsql/')) {
    throw new Error('TRAVA: DB_HOST aponta para socket /cloudsql/ — isso é Cloud SQL. Recusado.');
  }
  // Camada (2): nenhum parâmetro de query. `?port=`/`?host=` redirecionam a conexão REAL, e
  // um alvo local não precisa de nenhum parâmetro. Fora da lista de permissão ⇒ recusado.
  if (url.includes('?')) {
    throw new Error(
      'TRAVA: DATABASE_URL com query string — recusada. Parâmetros como "?port=" e "?host=" ' +
      'VENCEM a autoridade da URL para quem conecta (pg-connection-string), e nenhum alvo ' +
      'local precisa deles.',
    );
  }
}

/** Camada (1): ler com o parser de quem conecta, não com um parser parecido. */
function lerAlvo(url: string): AlvoLido {
  let cfg: { host?: string | null; port?: string | null; database?: string | null };
  try {
    cfg = parseConnectionString(url);
  } catch {
    throw new Error('TRAVA: DATABASE_URL não é uma URL válida — recusado sem tentar conectar.');
  }
  const porta = texto(cfg.port);
  return { host: texto(cfg.host), porta: porta === '' ? '5432' : porta, base: texto(cfg.database) };
}

/**
 * `null` quando o alvo está na lista de permissão; a mensagem `TRAVA:` do PRIMEIRO motivo
 * quando não está. Devolver o motivo em vez de lançar é o que permite às duas travas públicas
 * abaixo compartilharem a MESMA régua e divergirem só na consequência.
 */
function motivoNaoLocal(a: AlvoLido): string | null {
  if (!(LOCAL_DB_HOSTS as readonly string[]).includes(a.host)) {
    return `TRAVA: host "${a.host}" não é local. Permitidos: ${LOCAL_DB_HOSTS.join(', ')}.`;
  }
  if (!(LOCAL_DB_PORTS as readonly string[]).includes(a.porta)) {
    return `TRAVA: porta ${a.porta} não é a do docker local. 5434 (stg) e 5436 (PRD) estão BARRADAS.`;
  }
  if (a.base !== LOCAL_DB_NAME) {
    return `TRAVA: base "${a.base}" não é "${LOCAL_DB_NAME}".`;
  }
  return null;
}

/**
 * Devolve `host:porta/base` quando o alvo é comprovadamente o Postgres local em docker.
 * Lança `Error` com mensagem começando em `TRAVA:` em qualquer outro caso.
 *
 * ⚠️ Isto confere o alvo DECLARADO. Quem escreve deve reconferir o alvo MEDIDO depois de
 * conectar (`SELECT current_database(), inet_server_port()`): um alvo se declara, o outro
 * se mede, e só os dois juntos fecham.
 */
export function assertLocalDatabaseTarget(url: string | undefined): string {
  assertSemRedirecionamento(url);
  const alvo = lerAlvo(url);
  const motivo = motivoNaoLocal(alvo);
  if (motivo) throw new Error(motivo);
  return `${alvo.host}:${alvo.porta}/${alvo.base}`;
}

/**
 * ── A trava dos BACKFILLS que escrevem em linha de paciente ──────────────────────────────────
 *
 * Diferença em relação à `assertLocalDatabaseTarget`: estes scripts têm um caminho legítimo de
 * escrita fora do docker local, atrás de `--eu-sei-que-e-producao` (deliberadamente
 * desconfortável de digitar, e que ainda exige `--executar` e `--esperado`). O flag amplia a
 * lista de ALVOS aceitos — e só isso.
 *
 * 🔴 O flag NÃO desarma `assertSemRedirecionamento`: query string e socket `/cloudsql/` são
 * recusados COM ou SEM autorização. Motivo medido (gate F5, D1): a cópia local que os três
 * backfills carregavam terminava o regex em `(\?|$)` e classificava
 * `…@localhost:5432/enlite_e2e?port=5436` como "LOCAL (docker)" — o `pg` conectava na 5436
 * (PRD) sem que ninguém tivesse digitado o flag. Um alvo autorizado é um alvo que quem
 * autoriza CONSEGUE LER na linha de comando; `?port=`/`?host=` são exatamente o contrário.
 *
 * Devolve a MESMA classificação que as cópias devolviam ("LOCAL (docker)" /
 * "NÃO-LOCAL, autorizado explicitamente"), que é o que os três scripts imprimem em `ALVO:`.
 */
export function assertBackfillWriteTarget(url: string | undefined, producaoAutorizada: boolean): string {
  assertSemRedirecionamento(url);
  const motivo = motivoNaoLocal(lerAlvo(url));
  if (!motivo) return 'LOCAL (docker)';
  if (producaoAutorizada) return 'NÃO-LOCAL, autorizado explicitamente';
  throw new Error(
    'ALVO RECUSADO: este script escreve em linha de paciente. Alvo não-local exige ' +
    `--eu-sei-que-e-producao (e --executar e --esperado). Motivo: ${motivo}`,
  );
}
