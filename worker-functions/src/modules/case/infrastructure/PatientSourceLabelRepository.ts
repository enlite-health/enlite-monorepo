import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

/**
 * PatientSourceLabelRepository — o RÓTULO CRU da origem, ao lado do derivado.
 *
 * Task 2.2 da change `campos-admissao`. Tabelas: migration 284.
 *
 * ── POR QUE ISTO EXISTE ──────────────────────────────────────────────────────
 * O mapper colapsa DE PROPÓSITO as opções do ClickUp em enums nossos (F32:
 * `AT para Pacientes con TEA` e `Cuidado Integral de Pacientes con TEA` viram o MESMO
 * `ASD`, e o nível de serviço SOME). A Fase 1 fez o fallback GRITAR quando o rótulo é
 * desconhecido — mas gritar sem guardar o cru só troca perda silenciosa por perda
 * barulhenta (D-A.2). Aqui o rótulo LITERAL fica guardado, sempre, inclusive — e
 * principalmente — quando o derivado sai nulo: é isso que torna um rename na origem
 * REVERSÍVEL, porque o dado continua lá para ser remapeado depois.
 *
 * ── O TETO É DO BANCO; ISTO É A CAMADA QUE NÃO DEIXA ELE ESTOURAR EM SILÊNCIO ─
 * `patient_source_labels` só tem três posições por (paciente, campo) — PK + CHECK, sem
 * caminho para uma quarta linha (migration 284). Esta classe NÃO é o teto: ela é quem
 * GRITA E TRUNCA COM REGISTRO em vez de deixar o INSERT explodir ou de descartar calado
 * (Risks do `design.md`). Se esta classe sumisse, o banco continuaria recusando o 4º.
 *
 * ── ONDE CADA METADE DA RECUSA MORA (spec × C1 do `lex`) ─────────────────────
 * A spec exige que a recusa identifique o paciente e o valor recusado. A C1 do parecer
 * PROÍBE identificador de paciente e valor clínico em linha de log — o destino do
 * `console.warn` é o bucket `_Default` global, sem restrição de acesso, e o uuid/rótulo é
 * o valor clínico em forma decodificável por quem tem o token.
 *   → o REGISTRO durável vai para `patient_source_label_rejections`, dentro do banco;
 *   → a linha de LOG leva nome do campo + CONTAGEM, que é exatamente o que a C1 permite
 *     ("o campo X descartou N valores nesta rodada") e o que o operador precisa.
 *
 * ══ OS QUATRO DEFEITOS DO QA-CAÇA DA 2.2 QUE ESTE ARQUIVO FECHA ══════════════
 *
 * DEFEITO 2 — lista vazia APAGAVA o cru. `replaceForField({labels: []})` e `{labels: null}`
 *   deletavam os 3 rótulos gravados, sem registro, sem aviso, devolvendo sucesso. E `[]` é
 *   EXATAMENTE o que `ClickUpFieldResolver.resolveLabels` devolve quando NÃO CONSEGUE LER o
 *   campo (`if (!map) { warn; return []; }`) — a mesma forma para "ninguém preencheu" e para
 *   "o campo sumiu". É o `null` sobrecarregado da D167/F41 renascido dentro da tabela criada
 *   para sobreviver a ele: o rename é o evento que ESVAZIAVA a tabela da reversibilidade.
 *   ⇒ Conserto: a entrada deixa de ser uma lista e passa a ser uma LEITURA declarada
 *   (`PatientSourceLabelsRead`). O chamador tem de dizer, no tipo, se conseguiu ler. Não é
 *   `COALESCE` (a D-E o proíbe, e com razão: congelado *parece* dado) — vazio LEGÍTIMO
 *   continua apagando, que é o comportamento certo; só "não consegui ler" não escreve nada.
 *
 * DEFEITO 3 — o registro durável SUMIA no rollback do chamador. As recusas eram gravadas com
 *   o client do chamador; `PatientService.runUpsertTransaction` faz `ROLLBACK` em qualquer
 *   erro do upsert, e levava junto a única metade da recusa que identifica paciente e valor.
 *   Sobrava o `console.warn` com contagem — o alarme sem endereço.
 *   ⇒ Conserto: a recusa é gravada FORA da transação do chamador, numa conexão própria do
 *   pool, com transação própria. Rollback do chamador não a alcança.
 *
 * DEFEITO 4 — dois re-syncs CONCORRENTES do mesmo (paciente, campo) colidiam em
 *   `23505 patient_source_labels_pkey`: em READ COMMITTED o `DELETE` do segundo não enxerga
 *   as linhas que o primeiro acabou de inserir, e o `INSERT` bate na PK. Como o chamador tem
 *   tudo numa transação só, o upsert INTEIRO do paciente era perdido — identidade, clínico,
 *   endereços — e o webhook respondia `200 success:true`.
 *   ⇒ Conserto: lock consultivo por (paciente, campo), na transação, antes do DELETE. A
 *   idempotência prometida no docstring passa a valer também para a concorrência, não só
 *   para o tempo.
 *
 * DEFEITO 8 — cada re-sync acima do teto acrescentava OUTRA linha de recusa idêntica (com o
 *   rótulo clínico cru e o `patient_id`) e OUTRO `console.warn`: dado clínico crescendo sem
 *   regra e alarme afogado em ruído (critério 9.4 desta change).
 *   ⇒ Conserto: a recusa é ÚNICA por (paciente, campo, rótulo, motivo) — índice único no
 *   banco + `ON CONFLICT DO UPDATE` que incrementa `occurrences` e move `rejected_at`. O
 *   aviso sai só quando a recusa é NOVA; repetição não some (o contador cresce), ela só
 *   deixa de gritar a mesma coisa toda rodada.
 */

/** O teto. Espelha o CHECK `patient_source_labels_ceiling_3` da migration 284. */
/**
 * Teto PADRÃO de rótulos crus por (paciente, campo). D166/D-C, sobre segmento clínico.
 *
 * ⚠️ Não é mais o único: a migration 286 deu teto **5** a `Tipo de Dispositivo`, igual à
 * cardinalidade do catálogo dele — com isso truncar vira impossível em vez de administrado
 * (C-E′ do parecer do `lex`). Use `tetoDoCampo()`, nunca esta constante direto.
 */
export const PATIENT_SOURCE_LABEL_CEILING = 3;

/**
 * Tetos por campo que FOGEM do padrão. Espelha o `CHECK` da migration 286.
 *
 * ⚠️ **Duas constantes escritas à mão divergem em silêncio** — é o F20/F49/F51 desta casa, e já
 * mordeu 4× nesta change. Por isso existe um teste que LÊ a migration e compara com este mapa:
 * `tests/unit/__tests__/clickup-4.2-teto-por-campo.test.ts`. Se você mudar um lado sem o outro,
 * ele fica vermelho — o banco recusaria a escrita e o TypeScript acharia que podia.
 */
export const PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO: Readonly<Record<string, number | null>> = {
  // `null` = SEM teto. Ver migration 289: o limite deste campo é a FK de
  // `patient_device_types` para `device_types`, que se ajusta sozinha quando o catálogo muda.
  // A versão anterior punha `5` aqui, espelhando a cardinalidade do catálogo — e o catálogo
  // virou editável sem deploy no mesmo dia, o que tornava o 5 uma mentira no 6º tipo criado.
  'Tipo de Dispositivo': null,
};

/**
 * O teto que vale para um campo. `null` = sem teto.
 *
 * ⚠️ É esta função que o código deve consultar, nunca a constante direto — o teto deixou de ser
 * único quando `Tipo de Dispositivo` saiu da regra.
 */
export function tetoDoCampo(fieldName: string): number | null {
  return fieldName in PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO
    ? PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO[fieldName]
    : PATIENT_SOURCE_LABEL_CEILING;
}

export type PatientSourceLabelRejectionReason = 'ceiling' | 'blank' | 'duplicate';

export interface PatientSourceLabelRejection {
  rawLabel: string;
  reason: PatientSourceLabelRejectionReason;
}

/**
 * O que a ORIGEM devolveu para um campo — e se ela pôde ser lida.
 *
 * ⚠️ Esta união discriminada é o conserto do defeito 2, e ela é obrigatória de propósito:
 * um campo booleano opcional (`readable?: boolean`) seria esquecível, e o esquecimento
 * volta a ser "apagou o dado". Aqui o TypeScript obriga o chamador a declarar qual dos dois
 * mundos ele está em, porque só ele sabe:
 *
 *   `{ readable: true,  labels: [] }`   → o campo foi lido e está VAZIO. Apagar é correto:
 *                                          é a D-E (vazio se escreve; congelado parece dado).
 *   `{ readable: false, reason: '…' }`  → o campo NÃO pôde ser lido (renomeado, apagado, com
 *                                          outro tipo). NADA é escrito e NADA é apagado.
 *
 * `reason` é metadado de schema ('field-not-in-catalog', 'wrong-type', …), NUNCA valor de
 * paciente: ela vai para linha de log (C1 do parecer do `lex`).
 */
export type PatientSourceLabelsRead =
  | { readable: true; labels: readonly unknown[] }
  | { readable: false; reason: string };

/**
 * Açúcar para o chamador — e para que a forma correta seja a mais curta de escrever.
 *
 * ⚠️ **A assinatura NÃO aceita `null`/`undefined`, e isso é o conserto do defeito 1 da 2ª
 * rodada de QA.** A 1ª versão era `(labels: readonly unknown[] | null | undefined)` com
 * `labels ?? []`, então `sourceLabelsRead(null)` devolvia `{readable:true, labels:[]}` —
 * "li e está vazio". E `null`/`undefined` é EXATAMENTE a forma que `cf['Segmentos Clínicos']`
 * tem quando o campo some da tarefa. O tipo que existia para obrigar o chamador a declarar
 * se conseguiu ler tinha uma porta pela qual o não-lido entrava como lido.
 *
 * Duas camadas, porque uma só não fecha a classe:
 *   - o TIPO recusa `null`/`undefined` em tempo de compilação;
 *   - o RUNTIME recusa qualquer coisa que não seja array, porque `any`, `JSON.parse` e o
 *     `require` do `dist` passam por baixo do tipo (foi assim que o QA mediu o defeito).
 *
 * Não-array vira leitura ILEGÍVEL, nunca vazia: o pior resultado possível aqui é apagar.
 */
export const sourceLabelsRead = (labels: readonly unknown[]): PatientSourceLabelsRead => {
  if (!Array.isArray(labels)) {
    // C1: forma do valor, nunca o valor. `null` aqui é o campo que sumiu da tarefa.
    console.warn('[PatientSourceLabelRepository] sourceLabelsRead recebeu algo que não é lista — ' +
                 'tratado como ILEGÍVEL, não como vazio (D167/F41):', {
      valueType: labels === null ? 'null' : typeof labels,
    });
    return { readable: false, reason: 'not-a-list' };
  }
  return { readable: true, labels };
};
export const sourceLabelsUnreadable = (reason: string): PatientSourceLabelsRead =>
  ({ readable: false, reason });

export interface PatientSourceLabelWriteInput {
  patientId: string;
  /** Nome do campo NA ORIGEM (ex.: 'Segmentos Clínicos'). Metadado, nunca valor de paciente. */
  fieldName: string;
  /**
   * A LEITURA da origem — não uma lista. Ver `PatientSourceLabelsRead`: aceita `unknown[]`
   * de propósito, porque a API do ClickUp já devolveu número, string vazia, `false` e array
   * onde se esperava rótulo (C5 do parecer), e uma assinatura `string[]` empurraria a coerção
   * para o chamador, que é onde ela some.
   */
  read: PatientSourceLabelsRead;
  source?: string;
}

/** `written` = o conjunto foi substituído. `skipped-unreadable` = nada foi tocado (defeito 2). */
export type PatientSourceLabelWriteOutcome = 'written' | 'skipped-unreadable';

export interface PatientSourceLabelWriteResult {
  fieldName: string;
  /** O que a chamada FEZ. `skipped-unreadable` nunca apaga nem grava. */
  outcome: PatientSourceLabelWriteOutcome;
  /** Quantos itens vieram da origem (antes de qualquer filtro). */
  received: number;
  /** Vazio legítimo (null/undefined): ausência, não recusa. É o caso de 1424 de 1690 tarefas. */
  empty: number;
  /** Os rótulos efetivamente persistidos, na ordem em que ficaram (ordinal 1..N). */
  accepted: string[];
  /** O que foi recusado, com o motivo. Registrado também no banco. */
  rejected: PatientSourceLabelRejection[];
  /** Quantas dessas recusas são a PRIMEIRA vez (as demais só incrementaram o contador). */
  newlyRejected: number;
  /**
   * ONDE a recusa foi registrada — defeito 2 da 2ª rodada de QA.
   *
   * `'not-applicable'`      — não houve recusa nenhuma.
   * `'own-transaction'`     — conexão própria, transação própria: sobrevive ao rollback do
   *                           chamador. É o contrato do defeito 3 da 1ª rodada.
   * `'caller-transaction'`  — plano B. A linha existe, mas MORRE se o chamador der rollback.
   * `'none'`                — não foi registrada em lugar nenhum. Há recusa e não há registro.
   *
   * Existe porque `outcome: 'written'` estava escondendo os dois últimos: sob pool saturado o
   * QA mediu 2 recusas e apenas 1 sobrevivente, com o retorno dizendo sucesso nas duas.
   */
  rejectionsDurable: 'not-applicable' | 'own-transaction' | 'caller-transaction' | 'none';
}

export interface PatientSourceLabelRow {
  patientId: string;
  fieldName: string;
  ordinal: number;
  rawLabel: string;
  source: string;
}

export interface PatientSourceLabelRejectionRow extends PatientSourceLabelRejection {
  patientId: string;
  fieldName: string;
  ceiling: number | null;
  received: number | null;
  occurrences: number;
  firstRejectedAt: Date;
  rejectedAt: Date;
  /** Quando esta recusa gritou pela última vez. O alarme reacende quando a janela vence. */
  lastWarnedAt: Date;
}

/** Erro de recusa por teto no caminho de APPEND (`appendForField`). */
export class PatientSourceLabelCeilingError extends Error {
  constructor(
    readonly fieldName: string,
    readonly stored: number,
    readonly ceiling: number,
  ) {
    // Sem paciente e sem rótulo na mensagem — ela vai para log (C1).
    super(`[PatientSourceLabelRepository] ceiling reached for field "${fieldName}": ${stored}/${ceiling}`);
    this.name = 'PatientSourceLabelCeilingError';
  }
}

/**
 * Namespace do lock consultivo. `pg_advisory_xact_lock(int4, int4)` — o primeiro inteiro
 * separa este uso de qualquer outro lock consultivo do sistema; o segundo é o par
 * (paciente, campo). Colisão de hash só causa serialização desnecessária, nunca erro.
 */
const ADVISORY_LOCK_NAMESPACE = 'patient_source_labels';

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

export class PatientSourceLabelRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /**
   * Substitui o conjunto de rótulos crus de UM campo para UM paciente.
   *
   * É o caminho do sync: a origem manda a lista inteira do campo a cada tarefa, então o
   * estado persistido tem de refletir a lista atual — não acumular. O que passar do teto é
   * TRUNCADO com registro, nunca descartado em silêncio.
   *
   * Idempotente: rodar duas vezes com a mesma lista deixa exatamente as mesmas linhas —
   * inclusive quando as duas rodam AO MESMO TEMPO (defeito 4: o lock consultivo abaixo).
   *
   * NÃO APAGA quando a origem não pôde ser lida (defeito 2): `read.readable === false`
   * devolve `outcome: 'skipped-unreadable'` sem tocar em nada.
   */
  async replaceForField(
    input: PatientSourceLabelWriteInput,
    client?: PoolClient,
  ): Promise<PatientSourceLabelWriteResult> {
    const source = input.source ?? 'clickup';

    if (!input.read.readable) {
      // O conserto do defeito 2, e ele é uma NÃO-AÇÃO: sem DELETE, sem INSERT. "Não consegui
      // ler" nunca pode virar "está vazio" — é a tabela da reversibilidade que estava sendo
      // esvaziada justamente pelo evento (rename na origem) que ela existe para sobreviver.
      // C1: nome do campo + motivo estrutural. Nenhum valor, nenhum paciente.
      console.warn('[PatientSourceLabelRepository] origem ILEGÍVEL — nada gravado e nada apagado (D167/F41):', {
        field:  input.fieldName,
        reason: input.read.reason,
      });
      return {
        fieldName: input.fieldName, outcome: 'skipped-unreadable',
        received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0,
        rejectionsDurable: 'not-applicable',
      };
    }

    const plan = classify(input.read.labels, input.fieldName);

    await this.inTransaction(client, async (executor) => {
      await lockField(executor, input.patientId, input.fieldName);

      await executor.query(
        `DELETE FROM patient_source_labels WHERE patient_id = $1 AND field_name = $2`,
        [input.patientId, input.fieldName],
      );

      for (let i = 0; i < plan.accepted.length; i++) {
        await executor.query(
          `INSERT INTO patient_source_labels
             (patient_id, field_name, ordinal, raw_label, source, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [input.patientId, input.fieldName, i + 1, plan.accepted[i], source],
        );
      }
    });

    const registro = await this.recordRejectionsDurably(
      input.patientId, input.fieldName, plan.rejected, plan.received, source, client,
    );
    warnIfAnythingWasRefused(input.fieldName, plan, registro);
    return {
      fieldName: input.fieldName, outcome: 'written', ...plan,
      newlyRejected: registro.newlyRejected, rejectionsDurable: registro.durability,
    };
  }

  /**
   * Acrescenta UM rótulo cru ao que já existe — o caminho "uma quarta classificação chega
   * para o mesmo paciente" da spec.
   *
   * Recusa com `PatientSourceLabelCeilingError` quando o teto já está cheio, REGISTRA a
   * recusa no banco — FORA da transação do chamador, para que o `ROLLBACK` dele não leve o
   * registro junto (defeito 3) — e deixa os anteriores intactos. Duplicata exata é no-op
   * registrado.
   *
   * O teto é conferido aqui E no banco: a conferência daqui existe para produzir a recusa
   * legível e o registro; o banco é quem torna a quarta linha IMPOSSÍVEL, inclusive para
   * quem não passe por esta classe.
   */
  async appendForField(
    input: { patientId: string; fieldName: string; label: unknown; source?: string },
    client?: PoolClient,
  ): Promise<PatientSourceLabelWriteResult> {
    const source = input.source ?? 'clickup';
    const plan = classify([input.label], input.fieldName);

    type Decisao = {
      estourouOTeto: boolean;
      stored: number;
      accepted: string[];
      rejected: PatientSourceLabelRejection[];
      received: number;
      empty: number;
    };

    // Ler-e-decidir-e-inserir dentro da MESMA transação, sob o mesmo lock do caminho de
    // substituição: sem isso, dois appends simultâneos leem "2 gravados" e inserem o 3º e o
    // 4º — ou colidem na PK. Mesma raiz do defeito 4.
    const decisao = await this.inTransaction(client, async (executor): Promise<Decisao> => {
      await lockField(executor, input.patientId, input.fieldName);

      if (plan.accepted.length === 0) {
        // Vazio ou inválido: `classify` já decidiu, e a recusa (se houver) é registrada fora.
        return { estourouOTeto: false, stored: 0, accepted: [], rejected: plan.rejected, received: plan.received, empty: plan.empty };
      }

      const existing = await executor.query<{ ordinal: number; raw_label: string }>(
        `SELECT ordinal, raw_label FROM patient_source_labels
          WHERE patient_id = $1 AND field_name = $2 ORDER BY ordinal`,
        [input.patientId, input.fieldName],
      );
      const stored = existing.rows.map(r => r.raw_label);
      const label = plan.accepted[0];

      if (stored.includes(label)) {
        return { estourouOTeto: false, stored: stored.length, accepted: [], received: 1, empty: 0,
                 rejected: [{ rawLabel: label, reason: 'duplicate' }] };
      }

      const tetoAqui = tetoDoCampo(input.fieldName);
      if (tetoAqui !== null && stored.length >= tetoAqui) {
        return { estourouOTeto: true, stored: stored.length, accepted: [], received: 1, empty: 0,
                 rejected: [{ rawLabel: label, reason: 'ceiling' }] };
      }

      const proximo = firstFreeOrdinal(existing.rows.map(r => r.ordinal), input.fieldName);
      await executor.query(
        `INSERT INTO patient_source_labels
           (patient_id, field_name, ordinal, raw_label, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [input.patientId, input.fieldName, proximo, label, source],
      );
      return { estourouOTeto: false, stored: stored.length, accepted: [label], rejected: [], received: 1, empty: 0 };
    });

    // FORA da transação do chamador — é o ponto inteiro do conserto do defeito 3. Se isto
    // rodasse antes do `throw` mas DENTRO da transação dele, o `ROLLBACK` de
    // `PatientService.runUpsertTransaction` apagaria a única metade da recusa que diz QUAL
    // paciente e QUAL valor.
    const registro = await this.recordRejectionsDurably(
      input.patientId, input.fieldName, decisao.rejected, decisao.received, source, client,
    );
    warnIfAnythingWasRefused(
      input.fieldName,
      { received: decisao.received, empty: decisao.empty, accepted: decisao.accepted, rejected: decisao.rejected },
      registro,
    );

    if (decisao.estourouOTeto) {
      throw new PatientSourceLabelCeilingError(input.fieldName, decisao.stored, tetoDoCampo(input.fieldName) ?? -1);
    }

    return {
      fieldName: input.fieldName,
      outcome: 'written',
      received: decisao.received,
      empty: decisao.empty,
      accepted: decisao.accepted,
      rejected: decisao.rejected,
      newlyRejected: registro.newlyRejected,
      rejectionsDurable: registro.durability,
    };
  }

  /**
   * Suprime TODO rótulo cru e TODA linha de recusa de um paciente. É o cumprimento real da
   * **C-B do parecer do `lex` (24/08)** — e ele existe porque a alternativa não funcionava.
   *
   * ── O que a migration 284 afirmava, e por que era falso ──────────────────────
   * As duas tabelas têm `patient_id ... REFERENCES patients(id) ON DELETE CASCADE`, e o
   * comentário da migration apresentava esse CASCADE como o cumprimento dos arts. 4º inc. 5 e
   * 16 da Ley 25.326. **O CASCADE nunca dispara.** Medido: `grep -rn "DELETE FROM patients"`
   * no código de aplicação = ZERO; o único caminho de exclusão é
   * `UPDATE patients SET deleted_at = NOW()` (`ClickUpPatientWebhookController`, evento
   * `taskDeleted`). E isso não é uma lacuna a ser fechada com um `DELETE` — é **requisito de
   * produto**: a ata `2026-07-22a#REQ-04` registra *"ID único de paciente e nunca apagar
   * cadastro (soft delete), para preservar rastreabilidade de quem retorna"*.
   *
   * ⇒ O paciente PERMANECE, por decisão. O que não pode permanecer é o dado clínico literal
   * pendurado nele depois que a origem o removeu. Por isso a supressão é explícita, aqui, em
   * vez de implícita numa FK que nunca é exercida.
   *
   * ── Por que apaga de verdade em vez de marcar ────────────────────────────────
   * Estas tabelas não têm `deleted_at`, e não devem ter: a finalidade delas é reversibilidade
   * de rótulo da ORIGEM (art. 4º inc. 1 — pertinente à finalidade). Quando a origem some, a
   * finalidade some junto, e o art. 4º inc. 7 manda destruir *"cuando hayan dejado de ser
   * necesarios o pertinentes a los fines para los cuales hubiesen sido recolectados"*. Marcar
   * como apagado guardaria o dado sensível sem finalidade — o oposto do dever.
   *
   * ⚠️ O `patients.clinical_specialty` (o DERIVADO) NÃO é tocado aqui, de propósito: ele é
   * anterior a esta change, é categoria de uma lista fechada de 9, e mexer nele seria mudar o
   * comportamento do soft delete para além do que esta fase introduziu.
   *
   * Devolve o que apagou, em CONTAGEM — nunca rótulo (C1).
   */
  async purgeForPatient(patientId: string, client?: PoolClient): Promise<{ labels: number; rejections: number }> {
    const exec = client ?? this.pool;
    const r1 = await exec.query('DELETE FROM patient_source_labels WHERE patient_id = $1', [patientId]);
    const r2 = await exec.query('DELETE FROM patient_source_label_rejections WHERE patient_id = $1', [patientId]);
    const apagados = { labels: r1.rowCount ?? 0, rejections: r2.rowCount ?? 0 };
    // C1: contagem e id de paciente (que já é a chave do evento de supressão), nunca rótulo.
    console.info('[PatientSourceLabelRepository] rótulos crus suprimidos com o paciente (C-B/lex):', {
      patientId, ...apagados,
    });
    return apagados;
  }

  async findByPatientId(patientId: string, fieldName?: string): Promise<PatientSourceLabelRow[]> {
    const result = await this.pool.query<PatientSourceLabelRow>(
      `SELECT patient_id AS "patientId", field_name AS "fieldName",
              ordinal, raw_label AS "rawLabel", source
         FROM patient_source_labels
        WHERE patient_id = $1
          AND ($2::text IS NULL OR field_name = $2)
        ORDER BY field_name, ordinal`,
      [patientId, fieldName ?? null],
    );
    return result.rows;
  }

  async listRejections(patientId: string, fieldName?: string): Promise<PatientSourceLabelRejectionRow[]> {
    const result = await this.pool.query<PatientSourceLabelRejectionRow>(
      `SELECT patient_id AS "patientId", field_name AS "fieldName",
              raw_label AS "rawLabel", reason, ceiling, received, occurrences,
              first_rejected_at AS "firstRejectedAt",
              rejected_at AS "rejectedAt",
              last_warned_at AS "lastWarnedAt"
         FROM patient_source_label_rejections
        WHERE patient_id = $1
          AND ($2::text IS NULL OR field_name = $2)
        ORDER BY rejected_at DESC`,
      [patientId, fieldName ?? null],
    );
    return result.rows;
  }

  /**
   * Roda `fn` numa transação. Com `client`, é a transação DO CHAMADOR (entrar em outra aqui
   * quebraria o rollback dele); sem `client`, abre uma própria. Em qualquer caso existe UMA
   * transação — é o que dá sentido ao `pg_advisory_xact_lock`, que se solta no fim dela.
   */
  private async inTransaction<T>(
    client: PoolClient | undefined,
    fn: (executor: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (client) return fn(client);

    const own = await this.pool.connect();
    try {
      await own.query('BEGIN');
      const out = await fn(own);
      await own.query('COMMIT');
      return out;
    } catch (err) {
      await own.query('ROLLBACK').catch(() => { /* a conexão já pode ter morrido */ });
      throw err;
    } finally {
      own.release();
    }
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
  private async recordRejectionsDurably(
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
      own = await this.connectWithDeadline();
    } catch (err) {
      return this.fallbackRecord(patientId, fieldName, rejected, received, source, fallback, err,
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
      return this.fallbackRecord(patientId, fieldName, rejected, received, source, fallback, err, 'write-failed');
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
  private connectWithDeadline(): Promise<PoolClient> {
    const flight = this.pool.connect();
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
  private async fallbackRecord(
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
}

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

// ── Puro, testável sem banco ───────────────────────────────────────────────────

interface ClassifiedLabels {
  received: number;
  empty: number;
  accepted: string[];
  rejected: PatientSourceLabelRejection[];
}

/**
 * Decide o que entra, o que é ausência e o que é recusa — sem tocar no banco.
 *
 * LISTA DE PERMISSÃO, não de bloqueio (C5 do parecer): entra `string` com conteúdo. Todo o
 * resto é classificado explicitamente. O rótulo NÃO é aparado nem normalizado: 5 das 17
 * opções da lista do Javier terminam em NBSP (task 1.6), e "literal" quer dizer literal —
 * normalizar aqui seria inventar um rótulo que a origem não tem.
 */
export function classify(
  labels: readonly unknown[] | null | undefined,
  /**
   * ⚠️ O teto é POR CAMPO desde a migration 286, então `classify` precisa saber de qual campo
   * se trata. Default `''` cai no teto padrão (3) — nenhum chamador antigo muda de comportamento,
   * e quem quer o teto maior tem de dizer qual campo é.
   */
  fieldName = '',
): ClassifiedLabels {
  const entrada = labels ?? [];
  const accepted: string[] = [];
  const rejected: PatientSourceLabelRejection[] = [];
  let empty = 0;

  for (const value of entrada) {
    // Ausência é ausência: `null`/`undefined` é o campo que ninguém preencheu — o caso
    // legítimo de 1424 de 1690 tarefas (F51). Não é recusa e não vira registro.
    if (value === null || value === undefined) {
      empty += 1;
      continue;
    }

    if (typeof value !== 'string') {
      // Número, booleano, objeto, array: a origem entregou algo que não é rótulo. Isso é
      // defeito, não vazio — e a C5 mostrou que `Number()` transforma vários deles num
      // orderindex válido se ninguém barrar.
      rejected.push({ rawLabel: descreve(value), reason: 'blank' });
      continue;
    }

    if (value.trim() === '') {
      rejected.push({ rawLabel: value, reason: 'blank' });
      continue;
    }

    if (accepted.includes(value)) {
      rejected.push({ rawLabel: value, reason: 'duplicate' });
      continue;
    }

    const tetoDesteCampo = tetoDoCampo(fieldName);
    if (tetoDesteCampo !== null && accepted.length >= tetoDesteCampo) {
      rejected.push({ rawLabel: value, reason: 'ceiling' });
      continue;
    }

    accepted.push(value);
  }

  return { received: entrada.length, empty, accepted, rejected };
}

/** Descrição curta e limitada de um valor que não é rótulo. Vai para o BANCO, não para log. */
function descreve(value: unknown): string {
  let texto: string;
  try {
    texto = typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    texto = Object.prototype.toString.call(value);
  }
  if (texto === '' || texto === undefined) texto = Object.prototype.toString.call(value);
  return `[${typeof value}] ${texto}`.slice(0, 200);
}

function firstFreeOrdinal(usados: readonly number[], fieldName: string): number {
  // ⚠️ O teto é POR CAMPO desde a migration 286. Com o teto fixo em 3 aqui, o banco aceitaria
  // o 4º dispositivo (CHECK permite até 5) e esta função devolveria erro — código mais estreito
  // que o banco é tão errado quanto o contrário, e mais difícil de achar.
  // Sem teto ⇒ a próxima posição livre é sempre alcançável; o limite superior aqui é só uma
  // trava de sanidade contra laço infinito, não uma regra de negócio.
  const teto = tetoDoCampo(fieldName) ?? Number.MAX_SAFE_INTEGER;
  for (let i = 1; i <= teto; i++) {
    if (!usados.includes(i)) return i;
  }
  // Inalcançável: quem chama já conferiu o teto. Fica explícito em vez de devolver teto+1 e
  // deixar o CHECK do banco explodir com uma mensagem que não diz de onde veio.
  throw new PatientSourceLabelCeilingError(fieldName, usados.length, teto);
}

/**
 * Serializa TODA escrita de rótulos de um mesmo (paciente, campo) — o conserto do defeito 4.
 *
 * O par `DELETE` + `INSERT` não é atômico contra outra transação em READ COMMITTED: o
 * `DELETE` do segundo re-sync não enxerga as linhas que o primeiro acabou de inserir e ainda
 * não commitou, e o `INSERT` bate na PK (`23505`). Medido pelo QA: `sync A: OK` /
 * `sync B: FALHOU 23505`, com listas IDÊNTICAS, enquanto os mesmos dois em SEQUÊNCIA passam.
 *
 * `ON CONFLICT DO NOTHING` não serviria: esconderia a colisão e deixaria o conjunto sendo uma
 * mistura das duas listas. O lock é o que faz a segunda ESPERAR e reescrever o conjunto
 * inteiro — que é a semântica prometida ("o estado reflete a lista atual").
 *
 * `_xact_` é essencial: o lock se solta sozinho no fim da transação, inclusive num rollback.
 * Nada aqui pode ficar segurando lock se o chamador morrer.
 */
async function lockField(executor: PoolClient, patientId: string, fieldName: string): Promise<void> {
  await executor.query(
    `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2 || ':' || $3))`,
    [ADVISORY_LOCK_NAMESPACE, patientId, fieldName],
  );
}

/**
 * Uma linha por (paciente, campo, rótulo, motivo) — nunca uma por re-sync (defeito 8). O
 * índice único é do BANCO (migration 284), não uma convenção daqui: "regra que só existe na
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
function warnIfAnythingWasRefused(
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
