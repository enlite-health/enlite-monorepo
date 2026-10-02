/**
 * Banco FALSO em memória para os testes do SyncTalentumWorkersUseCase (spec 040 F3).
 * Roteia o SQL do use case por trecho de texto — NÃO é um Postgres: só serve para provar a lógica
 * (casamento, criação, completar, ligação à vaga). A prova contra Postgres de verdade é o e2e
 * `tests/e2e/sync-talentum-workers.test.ts`. Dados sintéticos; nada aqui é pessoa real.
 */

export interface FakeWorker {
  id: string;
  email: string | null;
  phone: string | null;
  authUid: string | null;
  status: string;
  firstNameEnc: string | null;
  lastNameEnc: string | null;
}

export interface FakeVacancy {
  id: string;
  talentumProjectId: string;
  caseNumber: number | null;
}

export class FakeWorkersDb {
  workers: FakeWorker[] = [];
  vacancies: FakeVacancy[] = [];
  wja = new Set<string>();
  encuadres: Array<{ workerId: string; jobPostingId: string; dedupHash: string; rawName: string; rawPhone: string | null }> = [];
  sqlLog: string[] = [];
  /** Força `23505` no INSERT de worker (corrida de criação). */
  uniqueViolationOnInsert = false;
  /** Com `uniqueViolationOnInsert`: o "outro processo" criou o worker (auth_uid) um instante antes. */
  concurrentWorkerWins = false;
  /** Faz o SQL que contém este trecho lançar (resiliência a erro por candidato). */
  failOn: string | null = null;
  /** O worker "some" entre o casamento e a leitura (SELECT email,…) / (SELECT status). */
  vanishOnRead = false;
  vanishOnStatus = false;
  private seq = 0;

  addWorker(w: Partial<FakeWorker>): FakeWorker {
    this.seq += 1;
    const full: FakeWorker = {
      id: `w-${this.seq}`, email: null, phone: null, authUid: null, status: 'REGISTERED',
      firstNameEnc: null, lastNameEnc: null, ...w,
    };
    this.workers.push(full);
    return full;
  }

  readonly query = jest.fn(async (sql: string, params: unknown[] = []) => {
    this.sqlLog.push(sql);
    if (this.failOn && sql.includes(this.failOn)) throw new Error('falha injetada');

    if (sql.includes('FROM job_postings')) {
      const ids = params[0] as string[];
      return { rows: this.vacancies.filter((v) => ids.includes(v.talentumProjectId))
        .map((v) => ({ id: v.id, talentum_project_id: v.talentumProjectId, case_number: v.caseNumber })) };
    }
    if (sql.includes('phone = ANY')) {
      const w = this.workers.find((x) => x.phone !== null && (params[0] as string[]).includes(x.phone));
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (sql.includes('LOWER(email) = LOWER($1) AND merged_into_id')) {
      const w = this.workers.find((x) => x.email !== null && x.email.toLowerCase() === String(params[0]).toLowerCase());
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (sql.includes('auth_uid = $1 AND merged_into_id')) {
      const w = this.workers.find((x) => x.authUid === params[0]);
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (sql.includes('auth_uid = $1 OR LOWER(email)')) {
      const w = this.workers.find((x) => x.authUid === params[0] || (params[1] !== null && x.email === params[1]));
      return { rows: w ? [{ id: w.id }] : [] };
    }
    if (sql.includes('INSERT INTO workers')) {
      if (this.uniqueViolationOnInsert) {
        if (this.concurrentWorkerWins) this.addWorker({ authUid: params[0] as string, status: 'INCOMPLETE_REGISTER' });
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const w = this.addWorker({
        authUid: params[0] as string, email: params[1] as string | null, phone: params[2] as string | null,
        firstNameEnc: params[3] as string | null, lastNameEnc: params[4] as string | null, status: 'INCOMPLETE_REGISTER',
      });
      return { rows: [{ id: w.id }] };
    }
    if (sql.includes('SELECT email, phone, first_name_encrypted')) {
      const w = this.vanishOnRead ? undefined : this.workers.find((x) => x.id === params[0]);
      return { rows: w ? [{ email: w.email, phone: w.phone, first_name_encrypted: w.firstNameEnc, last_name_encrypted: w.lastNameEnc, auth_uid: w.authUid }] : [] };
    }
    if (sql.startsWith('UPDATE workers SET')) {
      const w = this.workers.find((x) => x.id === params[params.length - 1]);
      if (w) {
        const sets = sql.slice('UPDATE workers SET '.length, sql.indexOf(' WHERE')).split(', ');
        sets.forEach((set, i) => {
          const col = set.split(' = ')[0];
          if (col === 'email') w.email = params[i] as string;
          if (col === 'phone') w.phone = params[i] as string;
          if (col === 'first_name_encrypted') w.firstNameEnc = params[i] as string;
          if (col === 'last_name_encrypted') w.lastNameEnc = params[i] as string;
          if (col === 'auth_uid') w.authUid = params[i] as string;
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT status FROM workers')) {
      const w = this.vanishOnStatus ? undefined : this.workers.find((x) => x.id === params[0]);
      return { rows: w ? [{ status: w.status }] : [] };
    }
    if (sql.includes('INSERT INTO worker_job_applications')) {
      const key = `${params[0]}|${params[1]}`;
      if (this.wja.has(key)) return { rows: [], rowCount: 0 };
      this.wja.add(key);
      return { rows: [{ id: key }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO encuadres')) {
      const [workerId, jobPostingId, rawName, rawPhone, dedupHash] = params as [string, string, string, string | null, string];
      if (!this.encuadres.some((e) => e.workerId === workerId && e.jobPostingId === jobPostingId)) {
        this.encuadres.push({ workerId, jobPostingId, dedupHash, rawName, rawPhone });
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`FakeWorkersDb: SQL não coberto: ${sql.slice(0, 80)}`);
  });
}
