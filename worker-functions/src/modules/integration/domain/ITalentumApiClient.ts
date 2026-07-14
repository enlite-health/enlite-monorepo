/**
 * ITalentumApiClient — domain interface for the Talentum.chat outbound API.
 *
 * Covers the prescreening project lifecycle: create, read, delete, list.
 * All methods are asynchronous and throw on HTTP/auth errors.
 */

// ─────────────────────────────────────────────────────────────────
// Input / Output types
// ─────────────────────────────────────────────────────────────────

export interface TalentumQuestion {
  question: string;
  type: 'text';
  responseType: ('text' | 'audio')[];
  desiredResponse: string;
  weight: number; // 1–10
  required: boolean;
  analyzed: boolean;
  earlyStoppage: boolean;
}

export interface TalentumFaq {
  question: string;
  answer: string;
}

export interface CreatePrescreeningInput {
  title: string;
  description: string;
  questions: TalentumQuestion[];
  faq?: TalentumFaq[];
  askForCv?: boolean;
  cvRequired?: boolean;
  linkedinRequired?: boolean;
}

export interface CreatePrescreeningResult {
  projectId: string;
  publicId: string;
}

/**
 * Corpo do UPDATE in-place (PUT /pre-screening/projects/:id). Edita um projeto já
 * publicado SEM recriar — preserva projectId, whatsappUrl e slug (provado contra a
 * Talentum real: PUT 204, links intactos). Diferente do create: NÃO aceita `type`
 * no top-level, e cada pergunta pode carregar `questionId` (mantém a identidade).
 */
export interface UpdatePrescreeningInput {
  title: string;
  description: string;
  questions: TalentumQuestionWithId[];
  faq?: TalentumFaq[];
}

// Question as it comes back from GET — extends base with server-assigned ID
export type TalentumQuestionWithId = TalentumQuestion & { questionId: string };

export interface TalentumProject {
  projectId: string;
  publicId: string;
  title: string;
  description: string;
  whatsappUrl: string;
  slug: string;
  active: boolean;
  timestamp: string;
  questions: TalentumQuestionWithId[];
  faq: TalentumFaq[];
}

// ─────────────────────────────────────────────────────────────────
// Dashboard types (GET /dashboard — candidate profiles, not projects)
// ─────────────────────────────────────────────────────────────────

export interface TalentumDashboardProfile {
  _id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  emails: Array<{ type: string; value: string }>;
  phoneNumbers: Array<{ type: string; value: string; normalizedPhoneNumber?: string }>;
  status: string;
  projects: Array<{ projectId: string | null; title: string; active: boolean }>;
}

export interface TalentumDashboardResponse {
  total: number;
  profiles: TalentumDashboardProfile[];
}

// ─────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────

export interface ListPrescreeningsOpts {
  page?: number;
  onlyOwnedByUser?: boolean;
}

export interface ITalentumApiClient {
  /** Create a new prescreening project. Returns the server-assigned IDs. */
  createPrescreening(input: CreatePrescreeningInput): Promise<CreatePrescreeningResult>;

  /**
   * Edita um projeto existente in-place (PUT). Preserva projectId/whatsappUrl/slug
   * — usado para atualizar perguntas (ex: habilitar áudio) sem recriar/repostar.
   */
  updatePrescreening(projectId: string, input: UpdatePrescreeningInput): Promise<void>;

  /** Fetch a prescreening project by its server-assigned projectId. */
  getPrescreening(projectId: string): Promise<TalentumProject>;

  /** Permanently delete a prescreening project. */
  deletePrescreening(projectId: string): Promise<void>;

  /** List prescreening projects for a single page. */
  listPrescreenings(opts?: ListPrescreeningsOpts): Promise<{ projects: TalentumProject[]; count: number }>;

  /** Iterate all pages and return every project. */
  listAllPrescreenings(): Promise<TalentumProject[]>;
}
