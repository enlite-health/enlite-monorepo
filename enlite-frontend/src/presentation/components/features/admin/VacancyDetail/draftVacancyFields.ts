/**
 * draftVacancyFields — a lista ÚNICA (fase 2, `completar-vacante-em-rascunho`) do que falta
 * preencher numa vaga em rascunho, e a contagem "N de M" derivada dela.
 *
 * Puro, sem React: `DraftVacancyPage.tsx` só chama.
 *
 * ── Por que M é fixo em 8, não o tamanho de `locked_fields` do GET ─────────────────────────
 * `locked_fields` (F3, fase 1) é a lista do que o FOGUETE já preencheu — 8 campos DIFERENTES
 * (`SOURCE_LOCKED_FIELDS` no backend: os 8 do foguete + os 5 de recrutamento que, com serviço
 * contratado, vêm do serviço — D523/057). Os 8 do foguete são "o que já sabemos" (coluna esquerda
 * do protótipo v3); "o que falta" é OUTRA lista, fixa no front (F24).
 *
 * Sem serviço as duas listas são DISJUNTAS. COM serviço (057/T4.4) quatro itens de "o que falta"
 * (profissão, sexo, experiência, dia de pagamento) passam a estar também em `locked_fields`:
 * saem do checklist e viram 1 item único "completar na ficha do paciente".
 *
 * `KNOWN_LOCKED_FIELDS` abaixo é o espelho de `SOURCE_LOCKED_FIELDS`: nome fora dele gera
 * `console.warn` (não lança — tolerância a deploy fora de ordem).
 */

/** Espelho de `SOURCE_LOCKED_FIELDS` (`worker-functions/.../vacancyCrudHelpers.ts`) — só para
 *  a validação de paridade acima; a tela NUNCA deriva a contagem "N de M" a partir daqui. */
export const KNOWN_LOCKED_FIELDS = [
  'case_number',
  'patient_id',
  'patient_address_id',
  'contracted_service_id',
  'age_range_min',
  'age_range_max',
  'schedule',
  'providers_needed',
  // D523 (057): com serviço contratado, os 5 campos de recrutamento também vêm do serviço.
  'required_sex',
  'required_professions',
  'required_experience',
  'work_schedule',
  'payment_day',
] as const;

/**
 * `locked_fields` do GET que este arquivo não conhece vira `console.warn` nomeando o campo —
 * NÃO lança: Cloud Run e Hosting deployam fora de ordem (057), e um nome novo do backend não
 * pode derrubar a tela. O warn é o sinal de que KNOWN_LOCKED_FIELDS ficou para trás.
 */
export function assertKnownLockedFields(lockedFields: readonly string[] | null | undefined): void {
  for (const field of lockedFields ?? []) {
    if (!(KNOWN_LOCKED_FIELDS as readonly string[]).includes(field)) {
      console.warn(
        `locked_fields trouxe um campo que draftVacancyFields.ts não conhece: "${field}". ` +
          'Adicione-o a KNOWN_LOCKED_FIELDS se for origem do serviço/paciente.',
      );
    }
  }
}

/** Uma vaga, como a tela a lê — campos soltos (o `getVacancyById` devolve `any`). */
export interface DraftVacancyLike {
  required_professions?: string[] | null;
  required_sex?: string | null;
  worker_profile_sought?: string | null;
  worker_attributes?: string | null;
  required_experience?: string | null;
  payment_day?: string | null;
  closes_at?: string | null;
  meet_link_1?: string | null;
  meet_link_2?: string | null;
  meet_link_3?: string | null;
}

export interface DraftTodoField {
  /** Nome do campo no payload da vaga — usado só para depuração/testes, não para exibição. */
  key: string;
  /** Chave i18n (sufixo, sob `admin.draftVacancy.todo.`). */
  labelKey: string;
  /** Chave i18n do texto auxiliar cinza à direita (sufixo, sob `admin.draftVacancy.todo.`). Opcional. */
  asideKey?: string;
  isEmpty: (vacancy: DraftVacancyLike) => boolean;
}

/**
 * A lista fixa, na ORDEM do protótipo v3 (F24) — "Lo que falta". 8 itens, sempre 8: M nunca
 * muda com o payload, só o "empty" de cada um muda entre `false`/`true`.
 */
export const DRAFT_TODO_FIELDS: readonly DraftTodoField[] = [
  {
    key: 'required_professions',
    labelKey: 'professionType',
    isEmpty: (v) => !v.required_professions || v.required_professions.length === 0,
  },
  {
    key: 'required_sex',
    labelKey: 'availableFor',
    asideKey: 'availableForAside',
    isEmpty: (v) => !v.required_sex,
  },
  {
    key: 'worker_profile_sought',
    labelKey: 'profileSought',
    isEmpty: (v) => !v.worker_profile_sought,
  },
  {
    key: 'worker_attributes',
    labelKey: 'workerAttributes',
    isEmpty: (v) => !v.worker_attributes,
  },
  {
    key: 'required_experience',
    labelKey: 'requiredExperience',
    isEmpty: (v) => !v.required_experience,
  },
  {
    key: 'payment_day',
    labelKey: 'paymentDay',
    isEmpty: (v) => !v.payment_day,
  },
  {
    key: 'closes_at',
    labelKey: 'closesAt',
    isEmpty: (v) => !v.closes_at,
  },
  {
    key: 'meet_links',
    labelKey: 'meetLinks',
    asideKey: 'meetLinksAside',
    isEmpty: (v) => !v.meet_link_1 && !v.meet_link_2 && !v.meet_link_3,
  },
];

/** Nomes dos campos de `DRAFT_TODO_FIELDS` — o outro lado da validação de paridade. */
export const DRAFT_TODO_FIELD_KEYS: readonly string[] = DRAFT_TODO_FIELDS.map((f) => f.key);

/** M — sempre 8, o tamanho da lista fixa. */
export const DRAFT_TODO_TOTAL = DRAFT_TODO_FIELDS.length;

/** Quantos de `DRAFT_TODO_FIELDS` estão vazios agora — o que falta completar. */
export function missingDraftFieldsCount(vacancy: DraftVacancyLike): number {
  return DRAFT_TODO_FIELDS.filter((f) => f.isEmpty(vacancy)).length;
}
