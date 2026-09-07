/**
 * AdminMapApiService
 *
 * Os dois mapas do painel (REQ-04 · DEC-14):
 *   - POST /api/admin/workers/map   → pontos de prestadores
 *   - POST /api/admin/patients/map  → pontos de pacientes (um por endereço ativo)
 *   - POST /api/admin/map/corridor  → o corredor: que linha serve os DOIS pontos
 *
 * É POST com corpo, não GET com query (lex 29/08, C2): o centro do raio é a
 * casa de alguém e a URL crua vai para o log do Cloud Run. O backend exige
 * ESCOPO (centro+raio ou província/localidade) e país (C3/C4).
 *
 * Mesmo padrão de `AdminWorkerListApiService` (fetch + FirebaseAuthService).
 */

import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

export type MapCountry = 'AR' | 'BR';
export interface MapCenter { lat: number; lng: number }

export interface WorkersMapFilters {
  country: MapCountry;
  status?: Array<'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED'>;
  docs_complete?: 'complete' | 'incomplete';
  docs_validated?: 'all_validated' | 'pending_validation';
  profession?: string[];
  state?: string;
  city?: string;
  center?: MapCenter;
  radius_km?: number;
  limit?: number;
}

export interface PatientsMapFilters {
  country: MapCountry;
  status?: string[];
  state?: string;
  city?: string;
  with_open_vacancies?: boolean;
  center?: MapCenter;
  radius_km?: number;
  limit?: number;
  /**
   * Busca por nome — é ESCOPO, não filtro: vale sozinha, sem centro e sem raio,
   * e é o que permite achar quem mora longe do centro do país. Vai no CORPO do
   * POST, nunca na URL: nome de paciente em query string entraria no log de
   * acesso do Cloud Run. Mínimo de 2 caracteres (o servidor devolve 400 com 1).
   */
  search?: string;
}

export interface WorkerMapPoint {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  status: string;
  documentsComplete: boolean;
  profession: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  distanceKm: number | null;
}

export interface PatientMapPoint {
  id: string;
  addressId: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  status: string;
  addressType: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  openVacancies: number;
  distanceKm: number | null;
}

/**
 * A rota de transporte público PORTA A PORTA entre um prestador e o domicílio
 * de atendimento de um paciente.
 *
 * `outcome` é o que a tela lê ANTES das rotas — as três saídas são diferentes e
 * não podem virar "lista vazia":
 *   `ok`            → há trajeto;
 *   `sem_ruta`      → o Google não achou trajeto de transporte público entre os
 *                     dois pontos (pode ser longe demais, ou zona sem serviço);
 *   `sem_cobertura` → falta coordenada numa das pontas, ou o par não existe no
 *                     escopo de quem perguntou. É diferente de "não há ônibus".
 */
export type RouteOutcome = 'ok' | 'sem_ruta' | 'sem_cobertura';

/**
 * Uma perna do trajeto.
 *
 * União DISCRIMINADA, e não um objeto com tudo opcional: perna a pé SEMPRE tem
 * metros e perna de transporte SEMPRE tem linha. Com campos opcionais cada uso
 * precisaria de um `?? 0` — ramos mortos que fingem cobrir caso que a
 * construção já impede.
 *
 * `paths` é o traçado, em polilinhas CODIFICADAS do Google — uma LISTA e não uma
 * string porque caminhadas consecutivas são fundidas numa perna só, e polilinha
 * codificada é delta-encoded: concatenar os textos produziria uma linha errada,
 * não uma linha maior. Quem desenha decodifica cada trecho e junta as
 * coordenadas. Lista vazia = perna sem traçado, que não se desenha.
 */
export type RouteLeg =
  | { kind: 'walk'; minutes: number; meters: number; paths: string[] }
  | { kind: 'transit'; minutes: number; line: string; mode: string; from: string; to: string; paths: string[];
      /** Cor oficial da linha (`#1b6633` para o 50 em CABA), validada no backend.
       *  `''` quando o Google não informa — o desenho cai na cor do tema. */
      color: string };

export interface TransitRoute {
  totalMinutes: number;
  /** Quantas trocas de veículo. ZERO é o caso bom — em Buenos Aires baldear se paga de novo. */
  transfers: number;
  lines: string[];
  legs: RouteLeg[];
}

export interface CorridorResponse {
  outcome: RouteOutcome;
  straightLineMeters: number | null;
  routes: TransitRoute[];
}

export interface CorridorRequest {
  country: MapCountry;
  workerId: string;
  patientAddressId: string;
}

export interface MapResponse<P> {
  data: P[];
  total: number;
  withoutCoordinates: number;
  truncated: boolean;
}

class AdminMapApiServiceClass {
  private readonly authService = new FirebaseAuthService();
  private readonly baseURL: string;

  constructor() {
    this.baseURL =
      (import.meta as { env?: Record<string, string> }).env?.VITE_API_WORKER_FUNCTIONS_URL ??
      'http://localhost:8080';
  }

  private async post<P>(path: string, body: unknown): Promise<MapResponse<P>> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return {
      data: json.data ?? [],
      total: json.total ?? 0,
      withoutCoordinates: json.withoutCoordinates ?? 0,
      truncated: json.truncated === true,
    };
  }

  getWorkersMap(filters: WorkersMapFilters): Promise<MapResponse<WorkerMapPoint>> {
    return this.post<WorkerMapPoint>('/api/admin/workers/map', filters);
  }

  getPatientsMap(filters: PatientsMapFilters): Promise<MapResponse<PatientMapPoint>> {
    return this.post<PatientMapPoint>('/api/admin/patients/map', filters);
  }

  /**
   * UM par por chamada — o backend recusa lista de propósito, para a rota não
   * virar gerador de matriz de distâncias.
   */
  async getCorridor(body: CorridorRequest): Promise<CorridorResponse> {
    const token = await this.authService.getIdToken();
    const response = await fetch(`${this.baseURL}/api/admin/map/corridor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Erro ao conectar ao servidor (HTTP ${response.status})`);
    }
    const json = await response.json();
    if (!json.success) throw new Error(json.error || `HTTP ${response.status}`);
    return json.data as CorridorResponse;
  }
}

export const AdminMapApiService = new AdminMapApiServiceClass();
