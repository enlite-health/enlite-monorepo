import { DateTime } from 'luxon';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger } from '@shared/logging';
import {
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
  isAdmissionCountry,
  resolveLineName,
  resolveTeamDisplayName,
} from '../domain/admissionCountries';
import {
  isHostRosterEnabled,
  resolveMinLeadMinutes,
  resolveSlotMinutes,
} from '../domain/admissionSchedulingConfig';
import { generateAdmissionCode } from '../domain/admissionCode';
import {
  AdmissionNotifier,
  LoggingAdmissionNotifier,
} from './AdmissionNotifier';
import type { AdmissionCalendarPort } from './ports/AdmissionCalendarPort';
import { TactiqLinkRequiredError, type TactiqLinkGate } from './ports/TactiqPorts';
import { isHostApt } from './admissionHostEligibility';
import {
  HostNotInRosterError,
  InvalidSlotError,
  PatientNotFoundError,
  SlotInPastError,
  SlotTakenError,
} from './AdmissionSchedulingErrors';
import { CalendarCreateFailedError, createEventWithRetry, releaseReservationWithoutEvent } from './admissionCalendarCreate';

export { HostNotInRosterError, InvalidSlotError, PatientNotFoundError, SlotInPastError, SlotTakenError };

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

/** Pedido de agenda feito pelo PAINEL: o responsável é escolhido por quem agenda (não há ranking). */
export interface PanelBookParams {
  patientId: string;
  hostEmail: string;
  slotStartISO: string;
  actorUid: string;
}

export interface PanelBookResult extends BookResult {
  admissionCode: string;
}

interface PatientRow {
  id: string;
  country: string;
  contact_email_encrypted: string | null;
  /**
   * E-mail do responsável primário. Quando quem preencheu o formulário público
   * é um familiar (`requesterType='responsible'`), o e-mail vai para
   * `patient_responsibles` e `contact_email_encrypted` fica nulo — sem isto o
   * evento saía sem convidado e a pessoa caía na sala de espera do Meet
   * (planning 26/08, PEND-09).
   */
  responsible_email_encrypted: string | null;
}

/** Candidata a atender um horário, com a carga da semana já medida. */
interface RankedHost {
  host: InterviewHost;
  busyMinutesInWeek: number;
}

const PATIENT_SELECT = `SELECT p.id, p.country, p.contact_email_encrypted,
              (SELECT r.email_encrypted
                 FROM patient_responsibles r
                WHERE r.patient_id = p.id AND r.email_encrypted IS NOT NULL AND r.active
                ORDER BY r.is_primary DESC, r.display_order ASC
                LIMIT 1) AS responsible_email_encrypted
         FROM patients p
        WHERE p.id = $1 AND p.deleted_at IS NULL`;

/** Quantas vezes sorteia outro código ADM se o índice único acusar colisão (36^6 ≈ 2 bi: na prática 1). */
const MAX_CODE_ATTEMPTS = 5;

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
    private readonly calendar: AdmissionCalendarPort = admissionCalendarService,
    private readonly notifier: AdmissionNotifier = new LoggingAdmissionNotifier(),
    private readonly encryption: KMSEncryptionService = new KMSEncryptionService(),
    private readonly impersonateEmail: string = process.env.ADMISSION_IMPERSONATE_EMAIL ||
      'enlite@enlite.health',
    private readonly hosts: InterviewHostRepository = interviewHostRepository,
    /**
     * A trava do vínculo do Tactiq (spec 049 F4, passo 3): o PAINEL só agenda com responsável de vínculo `linked`.
     * Sem o gate o `bookForHost` RECUSA (falha alta) — um gate ausente que deixasse passar seria a trava desligada
     * em silêncio. O fluxo do site (atribuição automática) não passa por aqui.
     */
    private readonly tactiqGate?: TactiqLinkGate,
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
   * Fuso do país: o da AGENDA de admissão no Google, com o default do código
   * como rede (D-fuso, 20/08). Um fuso só por país — não o de cada atendente —
   * porque a grade oferecida ao paciente é uma só.
   */
  private async resolveTimezone(country: AdmissionCountry, calendarId: string): Promise<string> {
    const cfg = getAdmissionCountryConfig(country);

    // Só no modo roster. Com a flag desligada o merge tem que ser NEUTRO, e
    // isto aqui não seria: acrescentaria uma chamada ao Google por request no
    // endpoint público e trocaria a fonte do fuso por algo editável fora do
    // código. Hoje os dois valores coincidem (medido 20/08), então ligar junto
    // com o roster não muda nada para quem já usa — muda a partir do flip.
    if (!isHostRosterEnabled()) return cfg.timezone;

    try {
      const tz = await this.calendar.getCalendarTimezone(calendarId, this.impersonateEmail);
      if (tz) return tz;
      logger.warn(
        { country, calendarId, fallback: cfg.timezone },
        '[admission] fuso da agenda ilegível: usando o default do país',
      );
    } catch (err) {
      logger.warn(
        { country, calendarId, fallback: cfg.timezone, erro: (err as Error).message },
        '[admission] falha ao ler o fuso da agenda: usando o default do país',
      );
    }
    return cfg.timezone;
  }

  /**
   * Disponibilidade pública do país. Devolve só horário + rótulo: nunca quem
   * está livre neles. Roster ligado e sem nenhuma atendente ativa → lista
   * vazia, sem erro (é o estado "Sem horários" da tela).
   */
  async getAvailableSlots(country: AdmissionCountry, now: Date = new Date()): Promise<PublicSlot[]> {
    const cfg = getAdmissionCountryConfig(country);

    // Roster ligado e ninguém cadastrado encerra AQUI, antes de resolver agenda
    // ou fuso: o spec manda responder "zero horários, sem erro", e um país que
    // ainda não tem agenda configurada não pode virar 500 na tela pública.
    const activeHosts = isHostRosterEnabled()
      ? await this.hosts.listActiveByCountry(country)
      : null;
    if (activeHosts && activeHosts.length === 0) {
      logger.warn(
        { country },
        '[admission] roster ligado e nenhuma atendente ativa: zero horários oferecidos',
      );
      return [];
    }

    const calendarId = this.resolveCalendarId(country);
    const timezone = await this.resolveTimezone(country, calendarId);

    // Janela de leitura: de hoje até um horizonte generoso (a fn pura corta em
    // N dias úteis + antecedência).
    const fromISO = DateTime.fromJSDate(now, { zone: timezone }).startOf('day').toISO() as string;
    const toISO = DateTime.fromJSDate(now, { zone: timezone })
      .plus({ days: READ_HORIZON_DAYS })
      .endOf('day')
      .toISO() as string;

    const busyIntervalsByHost = activeHosts
      ? await this.readHostsBusy(
          activeHosts.map((h) => h.email),
          fromISO,
          toISO,
          timezone,
          country,
        )
      : {
          [calendarId]: await this.calendar.getBusyIntervals(
            calendarId,
            this.impersonateEmail,
            fromISO,
            toISO,
            timezone,
          ),
        };
    // Todas as agendas ilegíveis (fail-closed) → nada a oferecer.
    if (Object.keys(busyIntervalsByHost).length === 0) return [];

    const slots = computeFreeSlots({
      busyIntervalsByHost,
      now,
      timezone,
      holidays: cfg.holidays,
      businessHours: cfg.businessHours,
      slotMinutes: resolveSlotMinutes(),
      minLeadMinutes: resolveMinLeadMinutes(),
    });

    return slots.map((s) => ({
      startISO: s.startISO,
      label: DateTime.fromISO(s.startISO)
        .setZone(timezone)
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
    // A linha (Care/Clinic) entra no título junto com o roster. Trocar o título
    // dos eventos que já são criados hoje não é neutro, e o merge precisa ser.
    const eventLabel = isHostRosterEnabled() ? resolveLineName(country) : teamName;
    const timezone = await this.resolveTimezone(country, calendarId);

    // 1) Paciente existe e é do país.
    const patient = await this.loadPatientForCountry(patientId, country);

    const slotStart = DateTime.fromISO(slotStartISO, { zone: timezone });
    if (!slotStart.isValid) throw new Error(`Invalid slotStartISO: ${slotStartISO}`);
    const slotEnd = slotStart.plus({ minutes: resolveSlotMinutes() });
    const startISO = slotStart.toISO() as string;
    const endISO = slotEnd.toISO() as string;

    const patientEmail = await this.resolveRequesterEmail(patient);

    if (!isHostRosterEnabled()) {
      return this.bookOnCountryCalendar({
        patientId,
        country,
        calendarId,
        teamName,
        eventLabel,
        startISO,
        endISO,
        timezone,
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
    const ranked = await this.rankFreeHostsForSlot(country, slotStart, slotEnd, timezone);
    if (ranked.length === 0) throw new SlotTakenError();

    for (const { host } of ranked) {
      // 3a) Re-check ao vivo desta candidata: entre o ranking e agora a agenda
      //     dela pode ter mudado.
      if (!(await this.isHostFreeAt(host.email, startISO, endISO, timezone))) continue;

      // 3b) Reserva o nosso lado ANTES do evento, sob UNIQUE(host_email,
      //     slot_start). Perder a corrida aqui não é erro: é a próxima candidata.
      const reserved = await this.reserveAndCreateEvent({
        patientId,
        country,
        calendarId,
        timezone,
        hostEmail: host.email,
        coHostEmail: host.email,
        teamName,
        eventLabel,
        startISO,
        endISO,
        patientEmail,
        createdVia: 'site',
        createdByUid: null,
        assignment: {
          mode: 'roster',
          candidatesConsidered: ranked.length,
          attemptsBeforeSuccess: ranked.findIndex((r) => r.host.email === host.email),
        },
      }).catch(nextHostOnCalendarFailure);
      if (!reserved) continue;

      return { appointmentId: reserved.appointmentId, hostDisplayName: teamName, slotStartISO: startISO, meetLink: reserved.meetLink };
    }

    // Todas as candidatas caíram no re-check ou na trava.
    throw new SlotTakenError();
  }

  /**
   * Trilha de auditoria da atribuição: por qual REGRA aquele compromisso ganhou
   * dono, em qual modo, e quantas candidatas foram consideradas.
   *
   * ⚠️ De propósito NÃO leva e-mail da atendente nem a carga dela. Quem atende
   * já está gravado em `admission_appointments.host_email`, que é trilha
   * durável e consultável; o log responde o "por quê", o banco responde o
   * "quem", e `appointmentId` costura os dois. Registrar minutos ocupados por
   * pessoa no Cloud Logging seria transformar auditoria em monitoramento de
   * empregada — é o que a condição CM3 do veredito do `lex` proíbe
   * (Ley 25.326 art. 9 / LGPD art. 46).
   */
  private logAssignment(input: {
    country: AdmissionCountry;
    appointmentId: string;
    mode: 'roster' | 'country_calendar';
    candidatesConsidered: number;
    attemptsBeforeSuccess: number;
  }): void {
    logger.info(
      {
        ...input,
        rule: input.mode === 'roster' ? 'least_busy_week_then_email_asc' : 'single_country_calendar',
      },
      '[admission] entrevista atribuída',
    );
  }

  // ─── internals ─────────────────────────────────────────────────────────────

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
    timezone: string,
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
      timezone,
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
          timezone,
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
    eventLabel: string;
    startISO: string;
    endISO: string;
    timezone: string;
    patientEmail?: string;
  }): Promise<BookResult> {
    const { patientId, country, calendarId, teamName, eventLabel, startISO, endISO, timezone } = input;

    if (await this.isAdmissionCalendarBusy(calendarId, startISO, endISO, timezone)) {
      throw new SlotTakenError();
    }

    const reserved = await this.reserveAndCreateEvent({
      patientId,
      country,
      calendarId,
      timezone,
      hostEmail: calendarId,
      teamName,
      eventLabel,
      startISO,
      endISO,
      patientEmail: input.patientEmail,
      createdVia: 'site',
      createdByUid: null,
      assignment: { mode: 'country_calendar', candidatesConsidered: 1, attemptsBeforeSuccess: 0 },
    }).catch(nextHostOnCalendarFailure);
    if (!reserved) throw new SlotTakenError();

    return { appointmentId: reserved.appointmentId, hostDisplayName: teamName, slotStartISO: startISO, meetLink: reserved.meetLink };
  }

  /**
   * O NÚCLEO DA RESERVA, um só para o site e para o painel (spec 049 F3): INSERT sob a trava
   * `UNIQUE(host_email, slot_start)` → evento no Google (título com o código `ADM-XXXXXX`) → refs → trilha de
   * atribuição → `notifier.onBooked`. Devolve `null` quando perdeu a corrida da trava (quem chamou decide: o roster
   * tenta a próxima candidata, o resto vira `SlotTakenError`). Colisão do CÓDIGO (índice único próprio) gera outro
   * código e tenta de novo — não é perda de horário.
   */
  private async reserveAndCreateEvent(input: {
    patientId: string;
    country: AdmissionCountry;
    calendarId: string;
    timezone: string;
    hostEmail: string;
    coHostEmail?: string;
    teamName: string;
    eventLabel: string;
    startISO: string;
    endISO: string;
    patientEmail?: string;
    createdVia: 'site' | 'panel';
    createdByUid: string | null;
    assignment: { mode: 'roster' | 'country_calendar'; candidatesConsidered: number; attemptsBeforeSuccess: number };
  }): Promise<{ appointmentId: string; meetLink: string; admissionCode: string } | null> {
    const { patientId, country, calendarId, timezone, teamName, startISO, endISO } = input;

    let appointmentId: string | null = null;
    let admissionCode = '';
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !appointmentId; attempt += 1) {
      admissionCode = generateAdmissionCode();
      try {
        appointmentId = await this.insertAppointment({
          patientId,
          country,
          hostEmail: input.hostEmail,
          hostDisplayName: teamName,
          slotStartISO: startISO,
          slotEndISO: endISO,
          admissionCode,
          createdVia: input.createdVia,
          createdByUid: input.createdByUid,
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (isCodeCollision(err)) continue;
        return null;
      }
    }
    if (!appointmentId) throw new Error('[AdmissionSchedulingService] não gerou um código ADM único');

    let created: { eventId: string; meetLink: string };
    try {
      created = await createEventWithRetry(
        this.calendar,
        {
          calendarId,
          impersonateEmail: this.impersonateEmail,
          summary: `Entrevista de admisión — ${input.eventLabel} · ${admissionCode}`,
          description: `Entrevista de admisión Enlite (${country}).`,
          startISO,
          endISO,
          timezone,
          ...(input.coHostEmail ? { coHostEmail: input.coHostEmail } : {}),
          patientEmail: input.patientEmail,
        },
        appointmentId,
      );
    } catch (err) {
      if (err instanceof CalendarCreateFailedError) await releaseReservationWithoutEvent(appointmentId, err.reason);
      throw err;
    }
    const { eventId, meetLink } = created;

    await this.attachCalendarRefs(appointmentId, eventId, meetLink);

    this.logAssignment({ country, appointmentId, ...input.assignment });

    await this.notifier.onBooked({
      appointmentId,
      patientId,
      country,
      hostEmail: input.hostEmail,
      hostDisplayName: teamName,
      slotStartISO: startISO,
      slotEndISO: endISO,
      meetLink,
      patientEmail: input.patientEmail,
    });

    return { appointmentId, meetLink, admissionCode };
  }

  /**
   * Agenda feita pelo PAINEL (spec 049 F3, `POST /patients/:id/admission-appointments`). Mesmas travas do site —
   * re-check ao vivo da agenda do responsável, `UNIQUE(host_email, slot_start)` — e o mesmo núcleo de reserva; muda a
   * regra de ENTRADA: o responsável é escolhido por quem agenda (precisa estar no roster ativo do país do paciente) e a
   * antecedência mínima é só "horário futuro" (a de 4 h do site não vale: admissão marca "daqui a 1 h" com a família
   * ao telefone). `created_via='panel'` + `created_by_uid`.
   */
  async bookForHost(params: PanelBookParams, now: Date = new Date()): Promise<PanelBookResult> {
    const { patientId, actorUid } = params;
    const patient = await this.loadPatient(patientId);
    const country = patient.country as AdmissionCountry;

    const calendarId = this.resolveCalendarId(country);
    const teamName = resolveTeamDisplayName(country);
    const eventLabel = isHostRosterEnabled() ? resolveLineName(country) : teamName;
    const timezone = await this.resolveTimezone(country, calendarId);

    const slotStart = DateTime.fromISO(params.slotStartISO, { zone: timezone });
    if (!slotStart.isValid) throw new InvalidSlotError();
    if (slotStart.toMillis() <= now.getTime()) throw new SlotInPastError();
    const slotEnd = slotStart.plus({ minutes: resolveSlotMinutes() });
    const startISO = slotStart.toISO() as string;
    const endISO = slotEnd.toISO() as string;

    const wanted = params.hostEmail.trim().toLowerCase();
    const roster = await this.hosts.listActiveByCountry(country);
    const host = roster.find((h) => h.email.toLowerCase() === wanted);
    if (!host) throw new HostNotInRosterError();
    await this.assertTactiqLinked(host.email);

    if (!(await this.isHostFreeAt(host.email, startISO, endISO, timezone))) throw new SlotTakenError();

    const patientEmail = await this.resolveRequesterEmail(patient);
    const reserved = await this.reserveAndCreateEvent({
      patientId,
      country,
      calendarId,
      timezone,
      hostEmail: host.email,
      coHostEmail: host.email,
      teamName,
      eventLabel,
      startISO,
      endISO,
      patientEmail,
      createdVia: 'panel',
      createdByUid: actorUid,
      assignment: { mode: 'roster', candidatesConsidered: 1, attemptsBeforeSuccess: 0 },
    });
    if (!reserved) throw new SlotTakenError();

    return {
      appointmentId: reserved.appointmentId,
      hostDisplayName: teamName,
      slotStartISO: startISO,
      meetLink: reserved.meetLink,
      admissionCode: reserved.admissionCode,
    };
  }

  /** Passo 3 do §3.0.1, NO SERVIDOR: responsável sem vínculo `linked` → 409 `TACTIQ_LINK_REQUIRED` (nada é criado). */
  private async assertTactiqLinked(hostEmail: string): Promise<void> {
    if (!this.tactiqGate) throw new Error('AdmissionSchedulingService: bookForHost exige o gate do vínculo do Tactiq (spec 049 F4)');
    const states = await this.tactiqGate.statesFor([hostEmail]);
    const state = states.get(hostEmail.toLowerCase()) ?? 'missing';
    if (!isHostApt(state)) throw new TactiqLinkRequiredError(state);
  }

  private async loadPatient(patientId: string): Promise<PatientRow> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<PatientRow>(PATIENT_SELECT, [patientId]);
    const row = res.rows[0];
    if (!row || !isAdmissionCountry(row.country)) throw new PatientNotFoundError();
    return row;
  }

  private async loadPatientForCountry(
    patientId: string,
    country: AdmissionCountry,
  ): Promise<PatientRow> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<PatientRow>(PATIENT_SELECT, [patientId]);
    const row = res.rows[0];
    if (!row) throw new PatientNotFoundError();
    if (row.country !== country) {
      throw new PatientNotFoundError(`Patient ${patientId} is not in country ${country}`);
    }
    return row;
  }

  /**
   * E-mail de quem vai entrar no Meet: o do paciente quando ele mesmo solicitou;
   * senão o do responsável primário (quem preencheu o formulário). É esse
   * e-mail que vira convidado do evento — convidado listado entra na sala sem
   * pedir autorização ao anfitrião.
   */
  private async resolveRequesterEmail(patient: PatientRow): Promise<string | undefined> {
    const cipher = patient.contact_email_encrypted || patient.responsible_email_encrypted;
    if (!cipher) return undefined;
    const email = await this.encryption.decrypt(cipher);
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
    admissionCode: string;
    createdVia: 'site' | 'panel';
    createdByUid: string | null;
  }): Promise<string> {
    const db = DatabaseConnection.getInstance().getPool();
    const res = await db.query<{ id: string }>(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status,
          admission_code, created_via, created_by_uid)
       VALUES ($1, $2, $3, $4, $5, $6, 'booked', $7, $8, $9)
       RETURNING id`,
      [
        input.patientId,
        input.country,
        input.hostEmail,
        input.hostDisplayName,
        input.slotStartISO,
        input.slotEndISO,
        input.admissionCode,
        input.createdVia,
        input.createdByUid,
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

/** Site: a falha do Google na criação não é erro para a família — esta responsável sai da disputa (null) e o horário foi liberado. */
function nextHostOnCalendarFailure(err: unknown): null {
  if (err instanceof CalendarCreateFailedError) return null;
  throw err;
}

/** Postgres unique_violation. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** A violação foi no índice do CÓDIGO ADM (não na trava host+horário). */
function isCodeCollision(err: unknown): boolean {
  return (err as { constraint?: string }).constraint === 'uq_admission_appointments_code';
}

export const admissionSchedulingService = new AdmissionSchedulingService();

/** Re-export for callers wiring env-based country configs. */
export { ADMISSION_COUNTRIES };
