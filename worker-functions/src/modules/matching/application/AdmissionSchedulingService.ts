import { DateTime } from 'luxon';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger } from '@shared/logging';
import {
  AdmissionCalendarService,
  admissionCalendarService,
  BusyInterval,
  computeFreeSlots,
  sumBusyMinutesInWeek,
} from '../infrastructure/AdmissionCalendarService';
import {
  InterviewHost,
  InterviewHostRepository,
  interviewHostRepository,
} from '../infrastructure/InterviewHostRepository';
import {
  ADMISSION_COUNTRIES,
  AdmissionCountry,
  getAdmissionCountryConfig,
  resolveTeamDisplayName,
} from '../domain/admissionCountries';
import {
  isHostRosterEnabled,
  resolveMinLeadMinutes,
  resolveSlotMinutes,
} from '../domain/admissionSchedulingConfig';
import {
  AdmissionNotifier,
  LoggingAdmissionNotifier,
} from './AdmissionNotifier';

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * O horário pedido não pode mais ser reservado: ninguém livre depois do
 * re-check, corrida perdida na trava do banco, ou pedido dentro da janela de
 * antecedência mínima. Um código só porque, para o paciente, a saída é a mesma
 * nos três casos — escolher outro horário.
 */
export class SlotTakenError extends Error {
  readonly code = 'SLOT_TAKEN';
  constructor(message = 'Slot no longer available') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

/** Patient not found, or not in the requested country. */
export class PatientNotFoundError extends Error {
  readonly code = 'PATIENT_NOT_FOUND';
  constructor(message = 'Patient not found') {
    super(message);
    this.name = 'PatientNotFoundError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PublicSlot {
  startISO: string;
  /** Human label formatted in the country's timezone (no host name). */
  label: string;
}

export interface BookParams {
  patientId: string;
  slotStartISO: string;
  country: AdmissionCountry;
}

export interface BookResult {
  appointmentId: string;
  hostDisplayName: string | null;
  slotStartISO: string;
  meetLink: string;
}

interface PatientRow {
  id: string;
  country: string;
  contact_email_encrypted: string | null;
}

/** Candidata a atender um horário, com a carga da semana já medida. */
interface RankedHost {
  host: InterviewHost;
  busyMinutesInWeek: number;
}

/** Quantos dias à frente a janela de leitura cobre (a fn pura corta no horizonte). */
const READ_HORIZON_DAYS = 21;

/**
 * AdmissionSchedulingService — orquestra o agendamento da entrevista de
 * admissão de paciente (multi-país AR + BR).
 *
 * Dois modos, escolhidos pela flag `ADMISSION_HOST_ROSTER_ENABLED` (D2), que
 * existe para o merge sair NEUTRO em produção e a virada ser reversível em
 * segundos, sem redeploy:
 *
 *   OFF (o que está no ar): a disponibilidade é a agenda de admissão do PAÍS —
 *   expediente menos o que já está marcado nela, capacidade 1 por horário. Sem
 *   pessoa atrelada ao horário.
 *
 *   ON (esta change): a disponibilidade é a UNIÃO das agendas pessoais das
 *   atendentes ativas do país (`interview_hosts`), lida por `freeBusy`. O
 *   horário aparece se ALGUMA estiver livre; a atribuição acontece no `book`,
 *   para a de semana mais leve, e a atendente entra como participante do
 *   evento — que é o que faz o compromisso chegar até ela. Foi a falta disso
 *   que deixou uma cliente sozinha no Meet em 18/08.
 *
 * Em ambos os modos o paciente vê apenas horários e o nome genérico da EQUIPE:
 * `host_display_name` é sempre o nome da equipe (é o que vai para a
 * confirmação por WhatsApp e para a tela), enquanto `host_email` guarda quem
 * de fato atende — a atendente no modo roster, a agenda do país no modo antigo.
 */
export class AdmissionSchedulingService {
  constructor(
    private readonly calendar: AdmissionCalendarService = admissionCalendarService,
    private readonly notifier: AdmissionNotifier = new LoggingAdmissionNotifier(),
    private readonly encryption: KMSEncryptionService = new KMSEncryptionService(),
    private readonly impersonateEmail: string = process.env.ADMISSION_IMPERSONATE_EMAIL ||
      'enlite@enlite.health',
    private readonly hosts: InterviewHostRepository = interviewHostRepository,
  ) {}

  private resolveCalendarId(country: AdmissionCountry): string {
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = process.env[cfg.admissionCalendarIdEnv];
    if (!calendarId) {
      throw new Error(
        `[AdmissionSchedulingService] missing env ${cfg.admissionCalendarIdEnv} for country ${country}`,
      );
    }
    return calendarId;
  }

  /**
   * Disponibilidade pública do país. Devolve só horário + rótulo: nunca quem
   * está livre neles. Roster ligado e sem nenhuma atendente ativa → lista
   * vazia, sem erro (é o estado "Sem horários" da tela).
   */
  async getAvailableSlots(country: AdmissionCountry, now: Date = new Date()): Promise<PublicSlot[]> {
    const cfg = getAdmissionCountryConfig(country);

    // Janela de leitura: de hoje até um horizonte generoso (a fn pura corta em
    // N dias úteis + antecedência).
    const fromISO = DateTime.fromJSDate(now, { zone: cfg.timezone }).startOf('day').toISO() as string;
    const toISO = DateTime.fromJSDate(now, { zone: cfg.timezone })
      .plus({ days: READ_HORIZON_DAYS })
      .endOf('day')
      .toISO() as string;

    const busyIntervalsByHost = await this.readAvailabilitySources(
      country,
      fromISO,
      toISO,
      cfg.timezone,
    );
    if (Object.keys(busyIntervalsByHost).length === 0) return [];

    const slots = computeFreeSlots({
      busyIntervalsByHost,
      now,
      timezone: cfg.timezone,
      holidays: cfg.holidays,
      businessHours: cfg.businessHours,
      slotMinutes: resolveSlotMinutes(),
      minLeadMinutes: resolveMinLeadMinutes(),
    });

    return slots.map((s) => ({
      startISO: s.startISO,
      label: DateTime.fromISO(s.startISO)
        .setZone(cfg.timezone)
        .setLocale('es')
        .toFormat("cccc d LLL, HH:mm"),
    }));
  }

  /**
   * Reserva uma entrevista de admissão. A ordem é o desenho (D6): candidatas
   * livres → ranking por carga → re-check ao vivo → INSERT primeiro, sob a
   * trava única → só então o evento no Google. Assim duas requisições
   * simultâneas nunca criam dois eventos, e nenhum evento fica órfão de linha
   * no banco.
   *
   * `now` é injetável pelo mesmo motivo que em `getAvailableSlots`: a
   * antecedência mínima precisa ser testável sem depender do relógio da máquina.
   */
  async book(params: BookParams, now: Date = new Date()): Promise<BookResult> {
    const { patientId, slotStartISO, country } = params;
    const cfg = getAdmissionCountryConfig(country);
    const calendarId = this.resolveCalendarId(country);
    const teamName = resolveTeamDisplayName(country);

    // 1) Paciente existe e é do país.
    const patient = await this.loadPatientForCountry(patientId, country);

    const slotStart = DateTime.fromISO(slotStartISO, { zone: cfg.timezone });
    if (!slotStart.isValid) throw new Error(`Invalid slotStartISO: ${slotStartISO}`);
    const slotEnd = slotStart.plus({ minutes: resolveSlotMinutes() });
    const startISO = slotStart.toISO() as string;
    const endISO = slotEnd.toISO() as string;

    const patientEmail = await this.decryptPatientEmail(patient);

    if (!isHostRosterEnabled()) {
      return this.bookOnCountryCalendar({
        patientId,
        country,
        calendarId,
        teamName,
        startISO,
        endISO,
        timezone: cfg.timezone,
        patientEmail,
      });
    }

    // 2) Antecedência mínima vale também na ESCRITA, não só na listagem: a tela
    //    pode ter sido carregada horas antes, e o pedido chega por uma API
    //    pública onde qualquer horário pode ser postado. Só no modo roster —
    //    ligar isto com a flag desligada mudaria produção no merge, e o merge
    //    tem que sair neutro (D2).
    if (slotStart.toMillis() < now.getTime() + resolveMinLeadMinutes() * 60_000) {
      throw new SlotTakenError('Slot is inside the minimum lead time window');
    }

    // 3) Roster: candidatas livres no horário, da mais leve para a mais cheia.
    const ranked = await this.rankFreeHostsForSlot(country, slotStart, slotEnd);
    if (ranked.length === 0) throw new SlotTakenError();

    for (const { host } of ranked) {
      // 3a) Re-check ao vivo desta candidata: entre o ranking e agora a agenda
      //     dela pode ter mudado.
      if (!(await this.isHostFreeAt(host.email, startISO, endISO, cfg.timezone))) continue;

      // 3b) Reserva o nosso lado ANTES do evento, sob UNIQUE(host_email,
      //     slot_start). Perder a corrida aqui não é erro: é a próxima candidata.
      let appointmentId: string;
      try {
        appointmentId = await this.insertAppointment({
          patientId,
          country,
          hostEmail: host.email,
          hostDisplayName: teamName,
          slotStartISO: startISO,
          slotEndISO: endISO,
        });
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }

      const { eventId, meetLink } = await this.calendar.createEventWithMeet({
        calendarId,
        impersonateEmail: this.impersonateEmail,
        summary: `Entrevista de admisión — ${teamName}`,
        description: `Entrevista de admisión Enlite (${country}).`,
        startISO,
        endISO,
        timezone: cfg.timezone,
        coHostEmail: host.email,
        patientEmail,
      });

      await this.attachCalendarRefs(appointmentId, eventId, meetLink);

      await this.notifier.onBooked({
        appointmentId,
        patientId,
        country,
        hostEmail: host.email,
        hostDisplayName: teamName,
        slotStartISO: startISO,
        slotEndISO: endISO,
        meetLink,
        patientEmail,
      });

      return { appointmentId, hostDisplayName: teamName, slotStartISO: startISO, meetLink };
    }

    // Todas as candidatas caíram no re-check ou na trava.
    throw new SlotTakenError();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /**
   * Fontes de ocupação do país, chaveadas por agenda. Modo antigo → uma
   * entrada (a agenda do país). Modo roster → uma por atendente ativa, lida por
   * `freeBusy`, e agenda ilegível fica FORA do resultado (fail-closed): melhor
   * oferecer menos horários do que oferecer um horário em que a pessoa está
   * ocupada e ninguém aparece.
   */
  private async readAvailabilitySources(
    country: AdmissionCountry,
    fromISO: string,
    toISO: string,
    timezone: string,
  ): Promise<Record<string, BusyInterval[]>> {
    if (!isHostRosterEnabled()) {
      const calendarId = this.resolveCalendarId(country);
      const busy = await this.calendar.getBusyIntervals(
        calendarId,
        this.impersonateEmail,
        fromISO,
        toISO,
        timezone,
      );
      return { [calendarId]: busy };
    }

    const hosts = await this.hosts.listActiveByCountry(country);
    if (hosts.length === 0) {
      logger.warn(
        { country },
        '[admission] roster ligado e nenhuma atendente ativa: zero horários oferecidos',
      );
      return {};
    }

    return this.readHostsBusy(
      hosts.map((h) => h.email),
      fromISO,
      toISO,
      timezone,
      country,
    );
  }

  /**
   * Ocupação das agendas das atendentes numa única requisição `freeBusy`,
   * descartando (com log) as que não puderam ser lidas.
   */
  private async readHostsBusy(
    emails: string[],
    fromISO: string,
    toISO: string,
    timezone: string,
    country: AdmissionCountry,
  ): Promise<Record<string, BusyInterval[]>> {
    const results = await this.calendar.getFreeBusyByCalendar(
      emails,
      this.impersonateEmail,
      fromISO,
      toISO,
      timezone,
    );

    const byHost: Record<string, BusyInterval[]> = {};
    for (const r of results) {
      if (r.error) {
        logger.error(
          { country, calendarId: r.calendarId, reason: r.error },
          '[admission] agenda de atendente ilegível: fica fora do cálculo (fail-closed)',
        );
        continue;
      }
      byHost[r.calendarId] = r.busy;
    }
    return byHost;
  }

  /**
   * Candidatas ao horário, ordenadas por carga da semana (menos minutos
   * ocupados primeiro) e, no empate, por e-mail ascendente — determinístico de
   * propósito: mesmo estado, mesma escolha, todas as vezes.
   *
   * A mesma leitura serve para as duas perguntas (D5): a janela é a SEMANA que
   * contém o horário, então dela sai tanto "está livre no horário?" quanto
   * "quantos minutos essa semana já tem?" — sem uma segunda requisição.
   */
  private async rankFreeHostsForSlot(
    country: AdmissionCountry,
    slotStart: DateTime,
    slotEnd: DateTime,
  ): Promise<RankedHost[]> {
    const cfg = getAdmissionCountryConfig(country);
    const hosts = await this.hosts.listActiveByCountry(country);
    if (hosts.length === 0) return [];

    const weekStart = slotStart.startOf('week');
    const weekEnd = weekStart.plus({ days: 7 });
    const busyByHost = await this.readHostsBusy(
      hosts.map((h) => h.email),
      weekStart.toISO() as string,
      weekEnd.toISO() as string,
      cfg.timezone,
      country,
    );

    const startMs = slotStart.toMillis();
    const endMs = slotEnd.toMillis();
    const startISO = slotStart.toISO() as string;

    const ranked: RankedHost[] = [];
    for (const host of hosts) {
      const busy = busyByHost[host.email];
      if (!busy) continue; // agenda ilegível → não é candidata (fail-closed)
      const occupied = busy.some(
        (b) => startMs < b.end.getTime() && b.start.getTime() < endMs,
      );
      if (occupied) continue;
      ranked.push({
        host,
        // Carga = só o expediente da semana do horário (CM5 do veredito do
        // `lex`): o que ela marcou às 22h ou no sábado não decide nada.
        busyMinutesInWeek: sumBusyMinutesInWeek(
          busy,
          startISO,
          cfg.timezone,
          cfg.businessHours,
          cfg.holidays,
        ),
      });
    }

    return ranked.sort((a, b) => {
      if (a.busyMinutesInWeek !== b.busyMinutesInWeek) {
        return a.busyMinutesInWeek - b.busyMinutesInWeek;
      }
      return a.host.email.localeCompare(b.host.email);
    });
  }

  /** Leitura fresca de UMA agenda no intervalo do horário (anti-corrida). */
  private async isHostFreeAt(
    hostEmail: string,
    fromISO: string,
    toISO: string,
    timezone: string,
  ): Promise<boolean> {
    const [result] = await this.calendar.getFreeBusyByCalendar(
      [hostEmail],
      this.impersonateEmail,
      fromISO,
      toISO,
      timezone,
    );
    if (!result || result.error) return false; // ilegível = não reserva
    const start = new Date(fromISO).getTime();
    const end = new Date(toISO).getTime();
    return !result.busy.some((b) => start < b.end.getTime() && b.start.getTime() < end);
  }

  /**
   * Caminho do modo antigo (flag OFF), preservado intacto: a agenda do país é a
   * única fonte, capacidade 1, sem pessoa atrelada.
   */
  private async bookOnCountryCalendar(input: {
    patientId: string;
    country: AdmissionCountry;
    calendarId: string;
    teamName: string;
    startISO: string;
    endISO: string;
    timezone: string;
    patientEmail?: string;
  }): Promise<BookResult> {
    const { patientId, country, calendarId, teamName, startISO, endISO, timezone } = input;

    if (await this.isAdmissionCalendarBusy(calendarId, startISO, endISO, timezone)) {
      throw new SlotTakenError();
    }

    let appointmentId: string;
    try {
      appointmentId = await this.insertAppointment({
        patientId,
        country,
        hostEmail: calendarId,
        hostDisplayName: teamName,
        slotStartISO: startISO,
        slotEndISO: endISO,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlotTakenError();
      throw err;
    }

    const { eventId, meetLink } = await this.calendar.createEventWithMeet({
      calendarId,
      impersonateEmail: this.impersonateEmail,
      summary: `Entrevista de admisión — ${teamName}`,
      description: `Entrevista de admisión Enlite (${country}).`,
      startISO,
      endISO,
      timezone,
      patientEmail: input.patientEmail,
    });

    await this.attachCalendarRefs(appointmentId, eventId, meetLink);

    await this.notifier.onBooked({
      appointmentId,
      patientId,
      country,
      hostEmail: calendarId,
      hostDisplayName: teamName,
      slotStartISO: startISO,
      slotEndISO: endISO,
      meetLink,
      patientEmail: input.patientEmail,
    });

    return { appointmentId, hostDisplayName: teamName, slotStartISO: startISO, meetLink };
  }

  private async loadPatientForCountry(
    patientId: string,
    country: AdmissionCountry,
  ): Promise<PatientRow> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<PatientRow>(
      `SELECT id, country, contact_email_encrypted
         FROM patients
        WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    const row = res.rows[0];
    if (!row) throw new PatientNotFoundError();
    if (row.country !== country) {
      throw new PatientNotFoundError(`Patient ${patientId} is not in country ${country}`);
    }
    return row;
  }

  private async decryptPatientEmail(patient: PatientRow): Promise<string | undefined> {
    if (!patient.contact_email_encrypted) return undefined;
    const email = await this.encryption.decrypt(patient.contact_email_encrypted);
    return email.trim() ? email.trim() : undefined;
  }

  /**
   * True se a agenda de admissão do país tem qualquer evento sobrepondo
   * [fromISO, toISO) (capacidade 1). Leitura fresca. Só no modo antigo.
   */
  private async isAdmissionCalendarBusy(
    calendarId: string,
    fromISO: string,
    toISO: string,
    timezone: string,
  ): Promise<boolean> {
    const busy = await this.calendar.getBusyIntervals(
      calendarId,
      this.impersonateEmail,
      fromISO,
      toISO,
      timezone,
    );
    const start = new Date(fromISO).getTime();
    const end = new Date(toISO).getTime();
    return busy.some((b) => start < b.end.getTime() && b.start.getTime() < end);
  }

  private async insertAppointment(input: {
    patientId: string;
    country: AdmissionCountry;
    hostEmail: string;
    hostDisplayName: string | null;
    slotStartISO: string;
    slotEndISO: string;
  }): Promise<string> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<{ id: string }>(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'booked')
       RETURNING id`,
      [
        input.patientId,
        input.country,
        input.hostEmail,
        input.hostDisplayName,
        input.slotStartISO,
        input.slotEndISO,
      ],
    );
    return res.rows[0].id;
  }

  private async attachCalendarRefs(
    appointmentId: string,
    calendarEventId: string,
    meetLink: string,
  ): Promise<void> {
    const db = DatabaseConnection.getInstance().getPool();
    await db.query(
      `UPDATE admission_appointments
          SET calendar_event_id = $2, meet_link = $3, updated_at = NOW()
        WHERE id = $1`,
      [appointmentId, calendarEventId, meetLink],
    );
  }
}

/** Postgres unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export const admissionSchedulingService = new AdmissionSchedulingService();

/** Re-export for callers wiring env-based country configs. */
export { ADMISSION_COUNTRIES };
