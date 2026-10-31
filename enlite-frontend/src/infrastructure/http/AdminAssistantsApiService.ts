/**
 * AdminAssistentesApiService — chat com os asistentes (spec 080, fase A).
 * Contrato: `specs/080-assistentes-no-app/contratos/rota-mensagens.md`. Molde: `AdminPedidosIaApiService.ts`.
 *
 * O contrato fixa o corpo de sucesso SEM envelope (`{ agentes }`); aceita-se também `{success:true,data}`.
 * Erro: `{ success:false, code, message }` → `AssistenteErro{code,status}`; status sem código conhecido
 * (403/404/409/429/502) cai no código do contrato daquele status.
 */
import { FirebaseAuthService } from "@infrastructure/services/FirebaseAuthService";
import {
  AssistenteErro,
  type Assistente,
  type AssistenteErroCodigo,
  type AssistenteMensagensPagina,
  type AssistenteRespostaEnvio,
} from "@domain/entities/Assistente";

const CODIGOS: readonly AssistenteErroCodigo[] = [
  "SEM_CELULA",
  "AGENTE_DESCONHECIDO",
  "AGENTE_INDISPONIVEL",
  "FORMATO_INVALIDO",
  "TETO_PESSOA_DIA",
  "TETO_AGENTE_MES",
  "ERRO_MODELO",
];

const CODIGO_POR_STATUS: Record<number, AssistenteErroCodigo> = {
  400: "FORMATO_INVALIDO",
  403: "SEM_CELULA",
  404: "AGENTE_DESCONHECIDO",
  409: "AGENTE_INDISPONIVEL",
  429: "TETO_PESSOA_DIA",
  502: "ERRO_MODELO",
};

export interface MensagensParams {
  limite?: number;
  antes?: string;
}

class AdminAssistentesApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env
        ?.VITE_API_WORKER_FUNCTIONS_URL ?? "http://localhost:8080";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok || json.success === false) {
      const code = typeof json.code === "string" ? json.code : undefined;
      const conhecido = CODIGOS.find((c) => c === code);
      const porStatus = CODIGO_POR_STATUS[response.status];
      const message =
        typeof json.message === "string" ? json.message : undefined;
      throw new AssistenteErro(
        conhecido ?? porStatus ?? "DESCONHECIDO",
        response.status,
        message,
      );
    }
    return (json.success === true && "data" in json ? json.data : json) as T;
  }

  async listar(): Promise<Assistente[]> {
    const r = await this.request<{ agentes: Assistente[] }>(
      "GET",
      "/api/admin/assistentes",
    );
    return r.agentes;
  }

  async mensagens(
    agente: string,
    params: MensagensParams = {},
  ): Promise<AssistenteMensagensPagina> {
    const qs = new URLSearchParams();
    if (params.limite !== undefined) qs.set("limite", String(params.limite));
    if (params.antes) qs.set("antes", params.antes);
    const q = qs.toString() ? `?${qs}` : "";
    return this.request<AssistenteMensagensPagina>(
      "GET",
      `/api/admin/assistentes/${encodeURIComponent(agente)}/mensagens${q}`,
    );
  }

  async enviar(
    agente: string,
    texto: string,
  ): Promise<AssistenteRespostaEnvio> {
    return this.request<AssistenteRespostaEnvio>(
      "POST",
      `/api/admin/assistentes/${encodeURIComponent(agente)}/mensagens`,
      { texto },
    );
  }
}

export const AdminAssistentesApiService = new AdminAssistentesApiServiceClass();
