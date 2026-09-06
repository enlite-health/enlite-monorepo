/**
 * GetTransitCorridorUseCase — a rota de transporte público PORTA A PORTA entre
 * um prestador e o domicílio de atendimento de um paciente.
 *
 * Requisito de negócio (Gabriel, 05/09): casa → casa. A caminhada das duas
 * pontas faz parte do problema real e não pode ser cortada.
 *
 * ⚖️ DECISÃO REGISTRADA: o parecer do `lex` (05/09) deu PARE neste desenho —
 * enviar ao Google, na mesma requisição, o ponto de um prestador e o de um
 * paciente é cesión a controlador independente (Ley 25.326 art. 11) mais
 * transferência internacional (art. 12), sem o consentimento que ainda não foi
 * coletado. **O Gabriel decidiu prosseguir assumindo essa responsabilidade**;
 * ver `.claude/docs/autorizacao-google-directions.md` e o registro em
 * `decisoes.md`. Quem mexer aqui depois: isto não é um descuido, é uma decisão
 * tomada com o parecer contrário na mão.
 *
 * As condições TÉCNICAS do parecer estão implementadas porque não custam nada e
 * reduzem o dano:
 *   - a chamada sai do SERVIDOR, nunca do navegador do staff (sem cookie de
 *     conta Google, com chave de servidor);
 *   - o par é re-autorizado pelo PAÍS nas duas leituras (dois ids num POST é um
 *     IDOR esperando acontecer);
 *   - um par por chamada, com rate limit por staff;
 *   - a trilha leva ids e desfecho, NUNCA minutos, metros ou baldeações —
 *     `(prestador, paciente, 37 min)` repetido sobre N prestadores é
 *     trilateração (ver `TransitCorridorController`).
 */
import type { Pool } from 'pg';
import { GoogleTransitDirections } from '../infrastructure/GoogleTransitDirections';
import { buildTransitRoutes, type TransitRouteResult } from '../domain/transitRoute';

export interface TransitCorridorInput {
  country: 'AR' | 'BR';
  workerId: string;
  patientAddressId: string;
}

export type TransitCorridorOutput = TransitRouteResult & {
  /** Distância em linha reta entre as duas pontas, em metros. `null` sem cobertura. */
  straightLineMeters: number | null;
};

interface PointRow { lat: string | number; lng: string | number }
const num = (v: string | number): number => (typeof v === 'number' ? v : parseFloat(v));

export class GetTransitCorridorUseCase {
  constructor(
    private readonly db: Pool,
    private readonly directions: GoogleTransitDirections = new GoogleTransitDirections(),
  ) {}

  async execute(input: TransitCorridorInput): Promise<TransitCorridorOutput> {
    const [origin, destination] = await Promise.all([
      this.workerPoint(input.workerId, input.country),
      this.patientAddressPoint(input.patientAddressId, input.country),
    ]);

    // Uma das pontas não existe NO ESCOPO de quem perguntou, ou não tem
    // coordenada: em qualquer dos casos não há rota a afirmar — e nada sai para
    // fora. É a guarda que impede a rota de virar sonda de existência.
    if (!origin || !destination) return { outcome: 'sem_cobertura', routes: [], straightLineMeters: null };

    const a = { lat: num(origin.lat), lng: num(origin.lng) };
    const b = { lat: num(destination.lat), lng: num(destination.lng) };

    const [raw, straightLineMeters] = await Promise.all([
      this.directions.transit(a, b),
      this.straightLine(origin, destination),
    ]);

    return { ...buildTransitRoutes(raw), straightLineMeters };
  }

  /**
   * A área de serviço mais recente do prestador — o MESMO critério do mapa
   * (`AdminWorkersMapController`). Sem isso, o pino e a rota poderiam sair de
   * pontos diferentes.
   */
  private async workerPoint(workerId: string, country: string): Promise<PointRow | null> {
    const { rows } = await this.db.query<PointRow>(
      `SELECT s.latitude AS lat, s.longitude AS lng
         FROM workers w
         JOIN worker_service_areas s ON s.worker_id = w.id AND s.deleted_at IS NULL
        WHERE w.id = $1 AND w.country = $2 AND w.merged_into_id IS NULL
          AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        ORDER BY s.updated_at DESC
        LIMIT 1`,
      [workerId, country],
    );
    return rows[0] ?? null;
  }

  private async patientAddressPoint(addressId: string, country: string): Promise<PointRow | null> {
    const { rows } = await this.db.query<PointRow>(
      `SELECT a.lat, a.lng
         FROM patient_addresses a
         JOIN patients p ON p.id = a.patient_id
        WHERE a.id = $1 AND p.country = $2 AND a.archived_at IS NULL
          AND a.lat IS NOT NULL AND a.lng IS NOT NULL
        LIMIT 1`,
      [addressId, country],
    );
    return rows[0] ?? null;
  }

  private async straightLine(a: PointRow, b: PointRow): Promise<number> {
    const { rows } = await this.db.query<{ m: string | number }>(
      `SELECT ST_Distance(
                ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography) AS m`,
      [a.lat, a.lng, b.lat, b.lng],
    );
    return Math.round(num(rows[0].m));
  }
}
