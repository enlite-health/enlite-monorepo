/**
 * PatientSourceLabelRead — o CONTRATO de entrada e de saída da escrita de rótulo cru.
 *
 * Extraído de `PatientSourceLabelRepository` pelo teto de 400 linhas. É aqui que mora a união
 * discriminada `PatientSourceLabelsRead` — o conserto do defeito 2 (lista vazia APAGAVA o cru)
 * — junto dos dois açúcares que a produzem, porque o tipo sem a porta de entrada certa é
 * exatamente o buraco que o QA mediu.
 *
 * O repositório continua re-exportando tudo daqui: nenhum chamador precisou trocar de import.
 */

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
