/**
 * ListJobsByRadiusForWorkerUseCase — `GET /api/workers/me/jobs?radius_km=` (spec 077 C-37, D661; spec 096 `view=home`).
 *
 * Raio só de `JOB_RADII_KM` (5/10/15/20/50/100); fora disso INVALID_RADIUS sem tocar o banco. Identidade SÓ pelo `uid`
 * do token: o prestador sai de `workers.auth_uid` dentro de `withActorContext` (conexão crua do pool cai na RLS de
 * país, mesma régua do GetWorkerItineraryUseCase). Prestador inexistente ou DISABLED → ACCOUNT_INACTIVE; sem zona viva
 * com ponto → NO_SERVICE_AREA (o app mostra a tela de cadastrar endereço, VG-06).
 *
 * `view=home` (096, DD-1/DD-2): aplica o perfil de match (horário, profissão, sexo) e devolve `center` (zona viva do próprio
 * prestador, 3 casas) e `applied`. O sexo do prestador é decifrado 1x aqui, nunca em SQL nem em log. Sem `view`, nada muda.
 */
import type { PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  readJobsByRadius,
  readJobsByRadiusForHome,
  readWorkerHomeProfile,
  type WorkerJobByRadius,
} from '../infrastructure/WorkerJobsByRadiusReader';
import { passesSex, profileApplied, type MatchProfileApplied } from '../infrastructure/matchProfile';

export const JOB_RADII_KM = [5, 10, 15, 20, 50, 100] as const;

export interface HomeExtras {
  center: { lat: number; lng: number };
  applied: MatchProfileApplied;
}

export type ListJobsByRadiusResult =
  | ({ ok: true; items: WorkerJobByRadius[] } & Partial<HomeExtras>)
  | { ok: false; code: 'INVALID_RADIUS' | 'NO_SERVICE_AREA' | 'ACCOUNT_INACTIVE' };

type RunInActorContext = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
type JobsReader = typeof readJobsByRadius;
type HomeDeps = {
  profileReader: typeof readWorkerHomeProfile;
  homeReader: typeof readJobsByRadiusForHome;
  decryptSex: (cipher: string) => Promise<string>;
};

const runWithPool: RunInActorContext = (fn) => withActorContext(DatabaseConnection.getInstance().getPool(), fn);

const defaultHome = (): HomeDeps => {
  const kms = new KMSEncryptionService();
  return {
    profileReader: readWorkerHomeProfile,
    homeReader: readJobsByRadiusForHome,
    decryptSex: (cipher) => kms.decrypt(cipher),
  };
};

export class ListJobsByRadiusForWorkerUseCase {
  private home: HomeDeps | null;

  constructor(
    private readonly run: RunInActorContext = runWithPool,
    private readonly reader: JobsReader = readJobsByRadius,
    home?: HomeDeps,
  ) {
    this.home = home ?? null;
  }

  async execute(authUid: string, radiusKm: number, opts: { view?: 'home' } = {}): Promise<ListJobsByRadiusResult> {
    if (!(JOB_RADII_KM as readonly number[]).includes(radiusKm)) return { ok: false, code: 'INVALID_RADIUS' };
    return this.run(async (client) => {
      const found = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1',
        [authUid],
      );
      const worker = found.rows[0];
      if (!worker || worker.status === 'DISABLED') return { ok: false, code: 'ACCOUNT_INACTIVE' } as const;
      if (opts.view === 'home') return this.executeHome(client, worker.id, radiusKm);
      const items = await this.reader(client, { workerId: worker.id, radiusKm });
      if (items === null) return { ok: false, code: 'NO_SERVICE_AREA' } as const;
      return { ok: true, items } as const;
    });
  }

  private async executeHome(client: PoolClient, workerId: string, radiusKm: number): Promise<ListJobsByRadiusResult> {
    this.home ??= defaultHome();
    const profile = await this.home.profileReader(client, workerId);
    if (profile === null) return { ok: false, code: 'NO_SERVICE_AREA' };
    const rows = await this.home.homeReader(client, { workerId, radiusKm, profile });
    // 1 decrypt por requisição, e só se alguma vaga restringe sexo.
    const restricts = rows.some((r) => r.required_sex !== null && r.required_sex !== '');
    const workerSex = restricts && profile.sexEncrypted ? await this.home.decryptSex(profile.sexEncrypted) : null;
    const items = rows
      .filter((r) => passesSex(r.required_sex, workerSex))
      .map(({ required_sex: _omit, ...item }) => item);
    return { ok: true, items, center: profile.center, applied: profileApplied(profile) };
  }
}
