import { Pool, PoolClient } from 'pg';
import { tetoDoCampo } from './PatientSourceLabelCeiling';
import type {
  PatientSourceLabelRejection,
  PatientSourceLabelWriteResult,
} from './PatientSourceLabelRead';
import type { ClassifiedLabels } from './PatientSourceLabelClassifier';

/**
 * PatientSourceLabelRejectionRecorder — as DUAS METADES da recusa: o registro DURÁVEL (que
 * sobrevive ao rollback do chamador) e a linha de LOG que a C1 do parecer do `lex` permite.
 *
 * Extraído de `PatientSourceLabelRepository` pelo teto de 400 linhas do `CLAUDE.md`. Nada de
 * comportamento mudou de lugar: mesma conexão própria com prazo próprio, mesmo plano B, mesma
 * janela de silêncio decidida no BANCO, mesmas contagens na linha de aviso.
 *
 * Funções livres, com o `pool` por PARÂMETRO — e não uma classe colaboradora construída no
 * construtor do repositório —, porque as suítes constroem o repositório por
 * `Object.create(PatientSourceLabelRepository.prototype)` e injetam só `pool`: um colaborador
 * criado no construtor nasceria `undefined` ali.
 */

/** Quanto tempo o registro durável pode esperar antes de cair no plano B. */
const REJECTION_STATEMENT_TIMEOUT = '3s';

/**
 * Quanto tempo esperar por uma CONEXÃO do pool para o registro durável — defeito 2 da 2ª
 * rodada de QA.
 *
 * `recordRejectionsDurably` pede uma 2ª conexão do MESMO pool que o chamador já ocupa. Com o
 * pool no teto, `pool.connect()` fica pendurado até `connectionTimeoutMillis` (10 s em
 * produção) e cobra isso de CADA sync: o QA mediu 10.222 ms e 10.543 ms em dois chamadores
 * simultâneos. Este prazo é MUITO menor de propósito — o registro da recusa é importante,
 * mas não vale segurar o webhook por dez segundos, e a espera não muda o resultado (o pool
 * saturado continua saturado). Estourar o prazo é uma falha como outra qualquer: cai no
 * plano B e GRITA, com causa nomeada.
 */
const REJECTION_CONNECT_TIMEOUT_MS = 1_000;

/**
 * De quanto em quanto tempo a MESMA recusa volta a gritar — defeito 4 da 2ª rodada de QA.
 *
 * O dedupe do defeito 8 (1ª rodada) usava `occurrences` do BANCO: a recusa gritava UMA vez
 * na vida do registro e nunca mais — nem depois de restart, nem um ano depois. Trocar
 * "alarme afogado em ruído" por "alarme que toca uma vez e cala para sempre" é trocar de
 * defeito, não consertar (critério 9.4). A janela é o meio-termo: repetição não vira linha
 * nova nem grito por webhook, mas o alarme RE-ACENDE enquanto o problema durar.
 *
 * A decisão é do BANCO (`last_warned_at`), não do processo: memória de processo zera no
 * deploy e passa a gritar a cada restart, que é o ruído de volta.
 */
const REJECTION_WARN_WINDOW = '24 hours';

/** O retrato ACUMULADO das recusas de um (paciente, campo) — quantas distintas, quantas vezes. */
interface StandingRejections {
  labels: number;
  occurrences: number;
}

/** O que o registro durável conseguiu fazer, e onde. Nunca uma exceção. */
interface RejectionRecord {
  /** Recusas que nasceram agora (`occurrences === 1`). */
  newlyRejected: number;
  /** Recusas que devem GRITAR nesta rodada: inéditas + as que saíram da janela de silêncio. */
  toWarn: number;
  /** O acumulado lido de volta do registro. `null` quando não deu para ler. */
  standing: StandingRejections | null;
  durability: PatientSourceLabelWriteResult['rejectionsDurable'];
}

/**
 * Grava a recusa de forma que ela SOBREVIVA ao rollback do chamador (defeito 3), e sem
 * duplicar linha a cada re-sync (defeito 8).
 *
 * Conexão PRÓPRIA do pool, transação própria: o `ROLLBACK` de
 * `PatientService.runUpsertTransaction` não alcança outra conexão.
 *
 * ⚠️ TRADE-OFF DECLARADO: se a transação do chamador falhar depois, fica registrada uma
 * recusa cujo upsert não foi commitado. É o lado certo para errar — a recusa É verdade
 * (aquele valor CHEGOU e foi refusado), e a alternativa era o que o QA mediu: recusa
 * apagada, alarme sem endereço, ninguém consegue agir.
 *
 * ⚠️ A FK para `patients` continua de pé (a exclusão do paciente tem de levar o registro
 * junto — art. 4º inc. 5 / art. 16 da Ley 25.326). Consequência: um paciente NOVO, ainda
 * não commitado pela transação do chamador, não é visível para esta conexão e o INSERT
 * falha com `23503`. Nesse caso — e em qualquer outro, inclusive `statement_timeout` —
 * cai-se para a transação do chamador, gritando que o registro pode não sobreviver. Nunca
 * silêncio, nunca travar o sync.
 *
 * ── O QUE A 2ª RODADA DE QA REPROVOU AQUI (defeitos 2 e 3 daquele bloco) ────
 *
 * (2) **Sob pool saturado, o conserto se desligava sozinho e cobrava caro.** A 2ª conexão
 *     saía do MESMO pool que o chamador já ocupa; com o pool no teto, `pool.connect()`
 *     esperava `connectionTimeoutMillis` INTEIRO (10 s em produção) antes de falhar — o QA
 *     mediu 10.222 ms e 10.543 ms — e o `sqlstate` do aviso saía `null`, então o log não
 *     distinguia "pool saturado" de qualquer outra falha.
 *     ⇒ A espera pela conexão tem prazo PRÓPRIO (`REJECTION_CONNECT_TIMEOUT_MS`) e a causa
 *     é NOMEADA (`connect-timeout` / `connect-failed` / `write-failed`).
 *
 * (3) **Sem `client` do chamador, a falha do registro fazia `replaceForField` LANÇAR depois
 *     de já ter commitado a substituição** — e o aviso da C1 sobre as recusas, que só roda
 *     DEPOIS daqui, nunca saía. As duas metades da recusa sumiam juntas.
 *     ⇒ Esta função **NÃO LANÇA MAIS**. Ela devolve o que conseguiu e ONDE conseguiu; quem
 *     chama sempre chega no aviso. Falhar em registrar a recusa não pode desfazer uma
 *     escrita que já aconteceu nem calar o alarme.
 *
 * ⚠️ E o aviso não afirma mais um plano B que não houve: sem `fallback` a durabilidade é
 * `'none'`, e a linha diz isso com todas as letras.
 *
 * Devolve quantas recusas eram INÉDITAS, quantas devem GRITAR nesta rodada (janela de
 * `REJECTION_WARN_WINDOW`), o retrato acumulado do campo e onde o registro caiu.
 */
export async function recordRejectionsDurably(
  pool: Pool,
  patientId: string,
  fieldName: string,
  rejected: readonly PatientSourceLabelRejection[],
  received: number,
  source: string,
  fallback?: PoolClient,
): Promise<RejectionRecord> {
  if (rejected.length === 0) {
    return { newlyRejected: 0, toWarn: 0, standing: null, durability: 'not-applicable' };
  }

  let own: PoolClient;
  try {
    own = await connectWithDeadline(pool);
  } catch (err) {
    return fallbackRecord(patientId, fieldName, rejected, received, source, fallback, err,
      (err as { code?: string }).code === 'ETIMEDOUT-REJECTION' ? 'connect-timeout' : 'connect-failed');
  }

  try {
    await own.query('BEGIN');
    await own.query(`SET LOCAL statement_timeout = '${REJECTION_STATEMENT_TIMEOUT}'`);
    const contagem = await upsertRejections(own, patientId, fieldName, rejected, received, source);
    const standing = await standingRejections(own, patientId, fieldName);
    await own.query('COMMIT');
    return { ...contagem, standing, durability: 'own-transaction' };
  } catch (err) {
    await own.query('ROLLBACK').catch(() => { /* a conexão já pode ter morrido */ });
    return fallbackRecord(patientId, fieldName, rejected, received, source, fallback, err, 'write-failed');
  } finally {
    own.release();
  }
}

/**
 * `pool.connect()` com prazo PRÓPRIO. O `connectionTimeoutMillis` do pool é do sistema
 * inteiro (10 s em produção) e aqui ele é caro demais: a recusa é importante, o webhook
 * pendurado por dez segundos é pior.
 *
 * ⚠️ A conexão abandonada é DEVOLVIDA quando (e se) chegar. Sem isto, cada estouro de
 * prazo vazaria uma conexão do pool — trocaríamos lentidão por esgotamento.
 */
function connectWithDeadline(pool: Pool): Promise<PoolClient> {
  const flight = pool.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `[PatientSourceLabelRepository] pool.connect() excedeu ${REJECTION_CONNECT_TIMEOUT_MS}ms`,
      ) as Error & { code?: string };
      err.code = 'ETIMEDOUT-REJECTION';
      // Quem chegar atrasado é devolvido ao pool, não vazado.
      flight.then(c => c.release(), () => { /* já rejeitou; nada a devolver */ });
      reject(err);
    }, REJECTION_CONNECT_TIMEOUT_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });

  return Promise.race([flight, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * O plano B, e ele agora é HONESTO sobre o que aconteceu. Nunca lança: a falha do registro
 * não pode desfazer uma escrita já commitada nem calar o aviso da C1 que vem depois.
 */
async function fallbackRecord(
  patientId: string,
  fieldName: string,
  rejected: readonly PatientSourceLabelRejection[],
  received: number,
  source: string,
  fallback: PoolClient | undefined,
  err: unknown,
  cause: 'connect-timeout' | 'connect-failed' | 'write-failed',
): Promise<RejectionRecord> {
  // C1: campo, contagem, causa e SQLSTATE. Nenhum rótulo, nenhum paciente.
  const diagnostico = {
    field:     fieldName,
    rejected:  rejected.length,
    cause,
    sqlstate:  (err as { code?: string }).code ?? null,
    errorName: err instanceof Error ? err.name : typeof err,
    fallback:  fallback ? 'caller-transaction' : 'none',
  };

  if (!fallback) {
    // Não existe plano B. Dizer "caindo para a transação do chamador" aqui seria descrever
    // um fallback que não houve — foi o que o QA mediu no defeito 3.
    console.error('[PatientSourceLabelRepository] registro durável da recusa FALHOU e NÃO HÁ plano B — ' +
                  'a recusa NÃO foi persistida (o alarme abaixo é tudo o que resta):', diagnostico);
    return { newlyRejected: 0, toWarn: rejected.length, standing: null, durability: 'none' };
  }

  console.warn('[PatientSourceLabelRepository] registro durável da recusa FORA da transação FALHOU — ' +
               'caindo para a transação do chamador (NÃO sobrevive a um rollback dele):', diagnostico);
  try {
    const contagem = await upsertRejections(fallback, patientId, fieldName, rejected, received, source);
    const standing = await standingRejections(fallback, patientId, fieldName);
    return { ...contagem, standing, durability: 'caller-transaction' };
  } catch (err2) {
    console.error('[PatientSourceLabelRepository] o plano B da recusa TAMBÉM falhou — ' +
                  'a recusa NÃO foi persistida em lugar nenhum:', {
      ...diagnostico,
      fallbackSqlstate:  (err2 as { code?: string }).code ?? null,
      fallbackErrorName: err2 instanceof Error ? err2.name : typeof err2,
    });
    // `toWarn` = tudo: sem registro não há dedupe, e calar seria perder o fato inteiro.
    return { newlyRejected: 0, toWarn: rejected.length, standing: null, durability: 'none' };
  }
}

/**
 * Uma linha por (paciente, campo, rótulo, motivo) — nunca uma por re-sync (defeito 8). O
 * índice único é do BANCO (migration 304), não uma convenção daqui: "regra que só existe na
 * aplicação é probabilidade" (D-C).
 *
 * Devolve quantas recusas eram INÉDITAS e quantas devem GRITAR nesta rodada.
 *
 * ⚠️ **O silêncio é por JANELA, não para sempre** — defeito 4 da 2ª rodada de QA. A 1ª versão
 * decidia por `occurrences === 1`: a recusa gritava uma vez na vida do registro e nunca mais,
 * nem depois de restart, nem um ano depois. `last_warned_at` só avança quando a janela
 * `REJECTION_WARN_WINDOW` vence, e o `RETURNING` compara com `NOW()` — que é o instante da
 * TRANSAÇÃO, constante dentro dela, então `last_warned_at >= NOW()` é verdade exatamente
 * quando esta linha acabou de nascer ou de reacender. A decisão mora no BANCO de propósito:
 * memória de processo zera no deploy e volta a gritar a cada restart, que é o ruído de volta.
 */
async function upsertRejections(
  executor: Pool | PoolClient,
  patientId: string,
  fieldName: string,
  rejected: readonly PatientSourceLabelRejection[],
  received: number,
  source: string,
): Promise<{ newlyRejected: number; toWarn: number }> {
  let novas = 0;
  let gritam = 0;
  for (const r of rejected) {
    const res = await executor.query<{ occurrences: number; warn_now: boolean }>(
      `INSERT INTO patient_source_label_rejections
         (patient_id, field_name, raw_label, reason, ceiling, received, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (patient_id, field_name, raw_label, reason) DO UPDATE
         SET occurrences = patient_source_label_rejections.occurrences + 1,
             received    = EXCLUDED.received,
             ceiling     = EXCLUDED.ceiling,
             source      = EXCLUDED.source,
             rejected_at = NOW(),
             last_warned_at = CASE
               WHEN patient_source_label_rejections.last_warned_at <= NOW() - $8::interval
                 THEN NOW()
               ELSE patient_source_label_rejections.last_warned_at
             END
       RETURNING occurrences, (last_warned_at >= NOW()) AS warn_now`,
      [patientId, fieldName, r.rawLabel, r.reason, tetoDoCampo(fieldName) ?? -1, received, source,
       REJECTION_WARN_WINDOW],
    );
    if (res.rows[0]?.occurrences === 1) novas += 1;
    if (res.rows[0]?.warn_now) gritam += 1;
  }
  return { newlyRejected: novas, toWarn: gritam };
}

/**
 * Lê de volta o registro durável — defeito 4 da 2ª rodada de QA: *"o registro durável não tem
 * LEITOR nenhum ... escrito por um lado e lido por ninguém"*.
 *
 * Este é o leitor do CAMINHO VIVO: o alarme deixa de falar só da rodada atual e passa a dizer
 * quantos rótulos distintos daquele campo estão RECUSADOS e há quantas vezes. É a diferença
 * entre "um rótulo foi recusado agora" e "este campo acumula 4 rótulos recusados, 37 vezes" —
 * a segunda é acionável, a primeira não.
 *
 * C1: só CONTAGEM sai daqui. Nem rótulo, nem paciente. A consulta identificada (`listRejections`)
 * continua existindo para quem tem o contexto certo, e é o que a spec exige que EXISTA.
 */
async function standingRejections(
  executor: Pool | PoolClient,
  patientId: string,
  fieldName: string,
): Promise<StandingRejections> {
  const res = await executor.query<{ labels: number; occurrences: number }>(
    `SELECT COUNT(*)::int AS labels, COALESCE(SUM(occurrences), 0)::int AS occurrences
       FROM patient_source_label_rejections
      WHERE patient_id = $1 AND field_name = $2`,
    [patientId, fieldName],
  );
  return { labels: res.rows[0]?.labels ?? 0, occurrences: res.rows[0]?.occurrences ?? 0 };
}

/**
 * A linha de log da C1: nome do campo + CONTAGEM. Nunca o rótulo, nunca o paciente.
 * Silenciar não seria conformidade — seria trocar de defeito (descarte em silêncio).
 *
 * Não sai a cada re-sync (defeito 8 da 1ª rodada): o QA mediu 5 re-syncs da mesma lista
 * gerando 5 avisos idênticos, que é o "alarme afogado em ruído" que o critério 9.4 desta
 * change existe para impedir.
 *
 * ⚠️ Mas TAMBÉM não cala para sempre (defeito 4 da 2ª rodada): o silêncio é uma JANELA
 * (`REJECTION_WARN_WINDOW`, decidida no banco por `last_warned_at`). Alarme que toca uma vez
 * na vida do registro e nunca mais é outro defeito, não o conserto do primeiro.
 *
 * ⚠️ E grita SEMPRE que o registro durável falhou: sem registro não há dedupe, e sem dedupe
 * calar é perder o fato inteiro. Era o defeito 3 da 2ª rodada — a exceção subia antes daqui
 * e o alarme não saía.
 */
export function warnIfAnythingWasRefused(
  fieldName: string,
  plan: Omit<ClassifiedLabels, never>,
  registro: RejectionRecord,
): void {
  if (plan.rejected.length === 0) return;
  if (registro.toWarn === 0) return;
  const porMotivo: Record<string, number> = {};
  for (const r of plan.rejected) porMotivo[r.reason] = (porMotivo[r.reason] ?? 0) + 1;
  console.warn('[PatientSourceLabelRepository] rótulos crus recusados (valor e paciente retidos — C1/lex):', {
    field: fieldName,
    received: plan.received,
    accepted: plan.accepted.length,
    rejected: plan.rejected.length,
    newlyRejected: registro.newlyRejected,
    warned: registro.toWarn,
    ceiling: tetoDoCampo(fieldName) ?? -1,
    byReason: porMotivo,
    // O leitor do registro durável (defeito 4): o acumulado do campo, em contagem.
    standingLabels:      registro.standing?.labels ?? null,
    standingOccurrences: registro.standing?.occurrences ?? null,
    // Onde a recusa ficou. `'none'`/`'caller-transaction'` é a durabilidade que NÃO houve.
    rejectionsDurable: registro.durability,
  });
}
