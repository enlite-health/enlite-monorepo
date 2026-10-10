import type {
  AdmissionEventInput,
  AdmissionEventSink,
  AdmissionMessageKind,
  AdmissionMessageRecord,
  AdmissionMessageStatus,
  AdmissionMessageStore,
} from '../../application/ports/AdmissionMessagingPorts';

/**
 * Dublê do armazém + trilha, com a MESMA regra do banco: UNIQUE(appointment_id, kind, attempt) no claim e a mesma
 * regra anti-regressão do callback. Só para teste de unidade; a prova contra Postgres real é o e2e.
 */
export class InMemoryAdmissionStore implements AdmissionMessageStore, AdmissionEventSink {
  readonly messages: (AdmissionMessageRecord & { requestedByUid: string | null })[] = [];
  readonly events: AdmissionEventInput[] = [];
  appointments = new Map<string, { slotStart: Date; status: string }>();
  private seq = 0;

  async claim(input: { appointmentId: string; kind: AdmissionMessageKind; attempt: number; requestedByUid?: string | null }): Promise<string | null> {
    // Cede o turno: dois claims "simultâneos" intercalam como no banco, e só o primeiro INSERT ganha.
    await Promise.resolve();
    const taken = this.messages.some((m) => m.appointmentId === input.appointmentId && m.kind === input.kind && m.attempt === input.attempt);
    if (taken) return null;
    const id = `msg-${(this.seq += 1)}`;
    this.messages.push({
      id,
      appointmentId: input.appointmentId,
      kind: input.kind,
      attempt: input.attempt,
      status: 'claimed',
      twilioSid: null,
      requestedByUid: input.requestedByUid ?? null,
    });
    return id;
  }

  async setStatus(id: string, status: AdmissionMessageStatus, twilioSid?: string | null): Promise<void> {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error('mensagem inexistente');
    m.status = status;
    if (twilioSid) m.twilioSid = twilioSid;
  }

  async listAttempts(appointmentId: string, kind: AdmissionMessageKind): Promise<AdmissionMessageRecord[]> {
    return this.messages.filter((m) => m.appointmentId === appointmentId && m.kind === kind).sort((a, b) => a.attempt - b.attempt);
  }

  async loadAppointmentWindow(appointmentId: string): Promise<{ slotStart: Date; status: string } | null> {
    return this.appointments.get(appointmentId) ?? null;
  }

  async applyDeliveryStatus(twilioSid: string, status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered'): Promise<AdmissionMessageRecord | null> {
    const m = this.messages.find((x) => x.twilioSid === twilioSid);
    if (!m || m.status === status) return null;
    const allowed = status === 'sent' ? m.status === 'claimed' : status === 'read' ? true : !['delivered', 'read'].includes(m.status);
    if (!allowed) return null;
    m.status = status;
    return { ...m };
  }

  async append(event: AdmissionEventInput): Promise<void> {
    this.events.push(event);
  }

  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}
