/**
 * GetTransitCorridorUseCase — "que linha de transporte serve o prestador E o
 * paciente, e a quantas quadras de cada um?".
 *
 * TUDO acontece dentro do perímetro: duas coordenadas que já são nossas, uma
 * tabela de paradas públicas, um ST_DWithin e uma interseção de conjuntos.
 * Nenhuma chamada externa, nenhum domicílio sai para terceiro — é essa forma
 * que dispensa a análise de cesión e de transferência internacional (parecer
 * lex 05/09/2026, caminho "roteador local").
 *
 * 🔒 O PAR É RE-AUTORIZADO AQUI, não só na borda. O endpoint recebe DOIS ids, e
 * dois ids é um IDOR esperando acontecer: quem pode ver o prestador não pode,
 * por isso, ver a casa de um paciente de outro país. Por isso as duas leituras
 * carregam o `country` do pedido no WHERE — quem não casar não existe, e o
 * resultado é `sem_cobertura`, indistinguível de "não achei" (não confirmamos a
 * existência de registro fora do escopo de quem perguntou).
 */
import type { Pool } from 'pg';
import { buildCorridor, WALK_RADIUS_METERS, type CorridorResult, type TransitStop } from '../domain/transitCorridor';

export interface TransitCorridorInput {
  country: 'AR' | 'BR';
  workerId: string;
  patientAddressId: string;
}

/**
 * Interseção, não `extends`: `CorridorResult` é uma UNIÃO discriminada por
 * `outcome`, e interface não estende união. A interseção preserva o
 * estreitamento — depois de `if (r.outcome === 'ok')` o TypeScript sabe que
 * `lines` está preenchida.
 */
export type TransitCorridorOutput = CorridorResult & {
  /** Distância em linha reta entre as duas pontas, em metros. `null` sem cobertura. */
  straightLineMeters: number | null;
};

interface PointRow { lat: string | number; lng: string | number }
interface StopRow {
  external_id: string;
  name: string;
  mode: string;
  lines: string[];
  distance_meters: string | number;
}

const meters = (v: string | number): number => (typeof v === 'number' ? v : parseFloat(v));

export class GetTransitCorridorUseCase {
  constructor(private readonly db: Pool) {}

  async execute(input: TransitCorridorInput): Promise<TransitCorridorOutput> {
    const [origin, destination] = await Promise.all([
      this.workerPoint(input.workerId, input.country),
      this.patientAddressPoint(input.patientAddressId, input.country),
    ]);

    // Uma das pontas não existe NO ESCOPO de quem perguntou, ou não tem
    // coordenada: em qualquer dos casos não há corredor a afirmar.
    if (!origin || !destination) return { outcome: 'sem_cobertura', lines: [], straightLineMeters: null };

    const [originStops, destinationStops, straightLineMeters] = await Promise.all([
      this.stopsNear(origin, input.country),
      this.stopsNear(destination, input.country),
      this.straightLine(origin, destination),
    ]);

    return { ...buildCorridor(originStops, destinationStops), straightLineMeters };
  }

  /**
   * A área de serviço mais recente do prestador — o MESMO critério do mapa
   * (`AdminWorkersMapController`): prefere a que tem coordenada, depois a mais
   * recente. Sem isso, o pino e a rota poderiam sair de pontos diferentes.
   */
  private async workerPoint(workerId: string, country: string): Promise<PointRow | null> {
    const { rows } = await this.db.query<PointRow>(
      `SELECT s.latitude AS lat, s.longitude AS lng
         FROM workers w
         JOIN worker_service_areas s ON s.worker_id = w.id AND s.deleted_at IS NULL
        WHERE w.id = $1
          AND w.country = $2
          AND w.merged_into_id IS NULL
          AND s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
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
        WHERE a.id = $1
          AND p.country = $2
          AND a.archived_at IS NULL
          AND a.lat IS NOT NULL
          AND a.lng IS NOT NULL
        LIMIT 1`,
      [addressId, country],
    );
    return rows[0] ?? null;
  }

  /**
   * As paradas a até `WALK_RADIUS_METERS` do ponto, com a distância já medida
   * pelo PostGIS (índice GIST). O teto de 200 existe para uma esquina densa não
   * virar uma leitura sem limite — em CABA o pior caso medido fica bem abaixo.
   */
  private async stopsNear(point: PointRow, country: string): Promise<TransitStop[]> {
    const { rows } = await this.db.query<StopRow>(
      `SELECT external_id, name, mode, lines,
              ST_Distance(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
         FROM transit_stops
        WHERE country = $4
          AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, $3)
        ORDER BY distance_meters
        LIMIT 200`,
      [point.lat, point.lng, WALK_RADIUS_METERS, country],
    );
    return rows.map((r) => ({
      externalId: r.external_id,
      name: r.name,
      mode: r.mode,
      lines: r.lines,
      distanceMeters: meters(r.distance_meters),
    }));
  }

  private async straightLine(a: PointRow, b: PointRow): Promise<number> {
    const { rows } = await this.db.query<{ m: string | number }>(
      `SELECT ST_Distance(
                ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography) AS m`,
      [a.lat, a.lng, b.lat, b.lng],
    );
    return Math.round(meters(rows[0].m));
  }
}
