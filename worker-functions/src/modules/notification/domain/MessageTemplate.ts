export interface TemplateButton {
  /** Texto exibido pro worker no WhatsApp (ex: 'Sí'). */
  label: string;
  /** ButtonPayload técnico que volta no webhook quando clicado (ex: 'confirm_yes'). */
  payload: string;
}

export interface MessageTemplate {
  id: string;
  slug: string;
  name: string;
  body: string;       // ex: 'Olá {{name}}, encontramos uma vaga...'
  category: string | null;
  isActive: boolean;
  /** Twilio Content Template SID (HX...). Quando presente, usa a Content API. */
  contentSid: string | null;
  /** Botões quick-reply definidos no Twilio Content API. NULL quando texto puro. */
  buttons: TemplateButton[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertMessageTemplateDTO {
  slug: string;
  name: string;
  body: string;
  category?: string | null;
  isActive?: boolean;
  contentSid?: string | null;
  buttons?: TemplateButton[] | null;
}
