/**
 * admissionLiveFixtures — semeia reuniões sintéticas (@example.test) com o relógio FIXO por parâmetro, para os e2e do job ao vivo
 * (spec 050, 4º passo). Cada reunião tem anfitriã própria (a trava de horário é por anfitriã e horário), então nenhuma colide.
 */
import type { Pool } from 'pg';

const MIN = 60_000;

export interface ReuniaoViva {
  /** Início marcado, em minutos a partir do `now` da fixture (negativo = passado). */
  inicioMin: number;
  /** Fim marcado, em minutos a partir do `now`. */
  fimMin: number;
  status?: 'booked' | 'cancelled' | 'no_show';
  /** `false` = sem código ADM. */
  comCodigo?: boolean;
  conferenceStartedMin?: number | null;
  conferenceEndedMin?: number | null;
  summaryFastState?: 'armed' | 'fired' | 'gave_up' | 'cancelled' | null;
  importStatus?: string | null;
}

export class LiveFixtures {
  private seq = 0;
  private patientId = '';
  constructor(private readonly admin: Pool, private readonly sufixo: string, readonly now: Date) {}

  host(): string {
    return `ana.live.${this.sufixo}@example.test`;
  }

  async iniciar(): Promise<void> {
    await this.limpar();
    this.patientId = (await this.admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent)
       VALUES ($1,'Carla','Sintetico','AR',false,true) RETURNING id`,
      [`e2e-050-live-${this.sufixo}`],
    )).rows[0].id;
  }

  async limpar(): Promise<void> {
    await this.admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`%.live.${this.sufixo}.%@example.test`]);
    await this.admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-live-${this.sufixo}`]);
  }

  private at(min: number | null | undefined): Date | null {
    return min === null || min === undefined ? null : new Date(this.now.getTime() + min * MIN);
  }

  async semear(r: ReuniaoViva): Promise<string> {
    this.seq += 1;
    const { rows } = await this.admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
          conference_started_at, conference_ended_at, summary_fast_state, import_status, created_at)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3::timestamptz,$4::timestamptz,$5,$6,CASE WHEN $7::boolean THEN 'ADM-' || upper(substr(md5(random()::text), 1, 6)) END,$8::timestamptz,$9::timestamptz,$10,$11, $12::timestamptz - interval '1 day') RETURNING id`,
      [
        this.patientId, `ana.live.${this.sufixo}.${this.seq}@example.test`, this.at(r.inicioMin), this.at(r.fimMin), r.status ?? 'booked',
        `https://meet.google.com/liv-${this.sufixo}${this.seq}-xyz`,
        r.comCodigo !== false,
        this.at(r.conferenceStartedMin), this.at(r.conferenceEndedMin), r.summaryFastState ?? null, r.importStatus ?? null, this.now,
      ],
    );
    return rows[0].id as string;
  }
}
