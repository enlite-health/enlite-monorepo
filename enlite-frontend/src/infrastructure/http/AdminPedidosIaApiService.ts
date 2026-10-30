/**
 * A API dos pedidos do Sol (spec 078, M3b-1) — `/api/admin/pedidos-ia`.
 *
 * Leitura sob `pedidos_ia:read`; cada decisão (aceitar / negar / descrever) sob `pedidos_ia:decidir` e grava
 * 1 evento no backend. Este cliente só carrega o dado: mostrar o botão ou não é do `useActionGate`, nunca daqui.
 * Contrato: `worker-functions/src/modules/agentes/README.md` — envelope `{success:true,data}` ou `{success:false,code}`.
 */
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { ApiError } from './ApiError';

export type PedidoStatus = 'novo' | 'aceito' | 'negado' | 'redirecionado';
export type PedidoAcao = 'aceitar' | 'negar' | 'descrever';

export interface PedidoAtitude {
  versao: number;
  degrau: number;
  conteudo: string;
  caso_teste: string;
  metrica_alvo: string;
  janela: string;
  gatilho_rollback: string;
}

export interface PedidoEvento {
  acao: PedidoAcao;
  actor_uid: string;
  actor_kind: 'humano' | 'agente' | 'sistema';
  ts: string;
  motivo?: string;
  comentario?: string;
}

export interface Pedido {
  id: string;
  assunto: string;
  /** Texto do pedido. O contrato HTTP atual não o devolve; a tela o mostra quando vier. */
  descricao?: string | null;
  autor: string;
  area: string;
  grave_gatilho: string;
  status: PedidoStatus;
  criado_em: string;
  idade_h: number;
  atitude_atual: PedidoAtitude | null;
  eventos: PedidoEvento[];
}

export interface PedidosFiltro {
  area?: string;
  status?: PedidoStatus;
  grave?: boolean;
}

export interface DecisaoResultado {
  evento_id: string;
  status: PedidoStatus;
}

class AdminPedidosIaApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as unknown as { env: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL ??
      'http://localhost:8080';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await response.json().catch(() => ({}))) as { success?: boolean; data?: T; code?: string; error?: string };
    if (!response.ok || json.success === false) {
      throw new ApiError({ success: false, error: json.error ?? json.code ?? `HTTP ${response.status}`, code: json.code }, response.status);
    }
    return json.data as T;
  }

  async list(filtro: PedidosFiltro = {}): Promise<Pedido[]> {
    const params = new URLSearchParams();
    if (filtro.area) params.set('area', filtro.area);
    if (filtro.status) params.set('status', filtro.status);
    if (filtro.grave !== undefined) params.set('grave', String(filtro.grave));
    const q = params.toString() ? `?${params}` : '';
    return this.request<Pedido[]>('GET', `/api/admin/pedidos-ia${q}`);
  }

  async get(id: string): Promise<Pedido> {
    return this.request<Pedido>('GET', `/api/admin/pedidos-ia/${encodeURIComponent(id)}`);
  }

  async aceitar(id: string): Promise<DecisaoResultado> {
    return this.request('POST', `/api/admin/pedidos-ia/${encodeURIComponent(id)}/aceitar`);
  }

  async negar(id: string, motivo: string): Promise<DecisaoResultado> {
    return this.request('POST', `/api/admin/pedidos-ia/${encodeURIComponent(id)}/negar`, { motivo });
  }

  async descrever(id: string, comentario: string): Promise<DecisaoResultado> {
    return this.request('POST', `/api/admin/pedidos-ia/${encodeURIComponent(id)}/descrever`, { comentario });
  }
}

export const AdminPedidosIaApiService = new AdminPedidosIaApiServiceClass();
