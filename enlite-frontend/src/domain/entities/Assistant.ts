/** Assistants in the app (spec 080, phase A) — types of the `assistants-service` contract (`rotas-gestoras-service.md`). */
export interface Assistant {
  slug: string;
  name: string;
  role: "MANAGER";
  /** null when the registry cannot tell the area (the picker shows "en breve"). */
  area: string | null;
  /** false = no runtime in phase A (the picker shows "en breve"). */
  available: boolean;
  /** ISO instant of the last message, or null when there is none. */
  last_at: string | null;
  /** Integer >= 0, derived by the service at read time. */
  unread_count: number;
}

export type AssistantAuthor = "PERSON" | "ASSISTANT";
export type AssistantValidator = "OK" | "CUT_CLINICAL" | "CUT_PERSONAL" | null;

export interface AssistantMessage {
  id: string;
  author: AssistantAuthor;
  text: string;
  tools: string[];
  validator: AssistantValidator;
  created_at: string;
}

export interface AssistantMessagesPage {
  conversation_id: string | null;
  messages: AssistantMessage[];
}

export interface AssistantTurn {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface AssistantSendResponse {
  conversation_id: string;
  message: AssistantMessage;
  turn: AssistantTurn;
}

export type AssistantErrorCode =
  | "TOKEN_MISSING"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "NOT_STAFF"
  | "NO_REACH"
  | "ASSISTANT_UNAVAILABLE"
  | "INVALID_FORMAT"
  | "INPUT_CLINICAL"
  | "PERSON_DAILY_CAP"
  | "ASSISTANT_MONTHLY_CAP"
  | "MODEL_ERROR"
  | "INTERNAL_ERROR"
  | "PLATFORM_UNAVAILABLE"
  | "UNKNOWN";

export class AssistantError extends Error {
  readonly code: AssistantErrorCode;
  readonly status: number;

  constructor(code: AssistantErrorCode, status: number, message?: string) {
    super(message ?? code);
    this.name = "AssistantError";
    this.code = code;
    this.status = status;
  }
}
