/**
 * InMemoryPatientDiagnosisRepository — FAKE que implementa `PatientDiagnosisRepositoryPort`
 * (spec 016 F2, mesmo espírito de `InMemoryTerminology` da F1: "trocar o adaptador por um fake
 * em memória e a suíte inteira continuar verde"). Usado só em teste — nunca em produção.
 *
 * Mesma regra de escopo do adaptador real (D263): nasce amarrado a UMA `DiagnosisSource`, e toda
 * ESCRITA (`create`, `promotePrimary`, `demotePrimary`, `deactivate`) filtra por ela — mesmo aqui,
 * onde "filtrar" é um `.filter()` de array, não `AND source = $N` de SQL, a garantia É A MESMA:
 * um fake CLICKUP não consegue mutar uma linha PANEL. Leitura (`listForPatient`) é a exceção
 * documentada no port: sempre global, para a ficha poder mostrar todas as origens.
 */
import { randomUUID } from 'crypto';
import { IcdCode } from '../../terminology/domain/IcdCode';
import { PatientDiagnosis } from '../domain/PatientDiagnosis';
import type { PatientDiagnosisProps } from '../domain/PatientDiagnosis';
import type { DiagnosisSource } from '../domain/DiagnosisSource';
import type {
  NewPatientDiagnosisInput,
  PatientDiagnosisRepositoryPort,
} from '../domain/PatientDiagnosisRepositoryPort';

/** Mesma constante de `PostgresPatientDiagnosisRepository` — infraestrutura, fora da régua do grep. */
const TERMINOLOGY_SYSTEM = 'ICD-11';

export class InMemoryPatientDiagnosisRepository implements PatientDiagnosisRepositoryPort {
  constructor(
    private readonly scope: DiagnosisSource,
    private readonly rows: Map<string, PatientDiagnosis> = new Map(),
    private readonly knownPatients: Set<string> = new Set(),
  ) {}

  /** Só para teste: declara um patientId como existente (equivalente a um INSERT em `patients`). */
  seedPatient(patientId: string): void {
    this.knownPatients.add(patientId);
  }

  async patientExists(patientId: string): Promise<boolean> {
    return this.knownPatients.has(patientId);
  }

  async create(input: NewPatientDiagnosisInput): Promise<PatientDiagnosis> {
    const now = new Date();
    const props: PatientDiagnosisProps = {
      id: randomUUID(),
      patientId: input.patientId,
      terminologySystem: TERMINOLOGY_SYSTEM,
      conceptUri: input.conceptUri,
      conceptCode: IcdCode.parse(input.conceptCode),
      conceptTitle: input.conceptTitle,
      conceptLanguage: input.conceptLanguage,
      conceptGroup: input.conceptGroup,
      catalogRelease: input.catalogRelease,
      source: this.scope,
      isPrimary: input.isPrimary,
      active: true,
      endedAt: null,
      country: 'AR',
      createdBy: input.actorUid,
      updatedBy: input.actorUid,
      createdAt: now,
      updatedAt: now,
    };
    const created = PatientDiagnosis.reconstruct(props);
    this.rows.set(created.id, created);
    return created;
  }

  async findById(id: string): Promise<PatientDiagnosis | null> {
    const row = this.rows.get(id);
    if (!row || !row.source.equals(this.scope)) return null;
    return row;
  }

  async listForPatient(patientId: string): Promise<PatientDiagnosis[]> {
    return [...this.rows.values()].filter((r) => r.patientId === patientId);
  }

  async findActiveByConceptCode(patientId: string, conceptCode: string): Promise<PatientDiagnosis | null> {
    for (const row of this.rows.values()) {
      if (
        row.source.equals(this.scope) &&
        row.patientId === patientId &&
        row.active &&
        row.conceptCode.value === conceptCode
      ) {
        return row;
      }
    }
    return null;
  }

  async withTransaction<T>(fn: (tx: PatientDiagnosisRepositoryPort) => Promise<T>): Promise<T> {
    // Fake single-threaded: "transação" é só rodar fn contra o mesmo estado compartilhado.
    return fn(this);
  }

  async demotePrimary(patientId: string): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.patientId === patientId && row.source.equals(this.scope) && row.isPrimary && row.active) {
        this.rows.set(id, PatientDiagnosis.reconstruct({ ...propsOf(row), isPrimary: false }));
      }
    }
  }

  async promotePrimary(id: string, actorUid: string): Promise<PatientDiagnosis> {
    const row = this.rows.get(id);
    if (!row || !row.source.equals(this.scope)) throw new Error(`Diagnóstico ${id} não encontrado no escopo ${this.scope.value}`);
    row.assertCanBecomePrimary();
    const updated = PatientDiagnosis.reconstruct({ ...propsOf(row), isPrimary: true, updatedBy: actorUid, updatedAt: new Date() });
    this.rows.set(id, updated);
    return updated;
  }

  async deactivate(id: string, actorUid: string): Promise<PatientDiagnosis> {
    const row = this.rows.get(id);
    if (!row || !row.source.equals(this.scope)) throw new Error(`Diagnóstico ${id} não encontrado no escopo ${this.scope.value}`);
    row.assertCanDeactivate();
    const updated = PatientDiagnosis.reconstruct({
      ...propsOf(row),
      isPrimary: false,
      active: false,
      endedAt: new Date(),
      updatedBy: actorUid,
      updatedAt: new Date(),
    });
    this.rows.set(id, updated);
    return updated;
  }
}

/** Extrai os props de uma entidade já reconstruída, para montar a PRÓXIMA versão imutável. */
function propsOf(d: PatientDiagnosis): PatientDiagnosisProps {
  return {
    id: d.id,
    patientId: d.patientId,
    terminologySystem: d.terminologySystem,
    conceptUri: d.conceptUri,
    conceptCode: d.conceptCode,
    conceptTitle: d.conceptTitle,
    conceptLanguage: d.conceptLanguage,
    conceptGroup: d.conceptGroup,
    catalogRelease: d.catalogRelease,
    source: d.source,
    isPrimary: d.isPrimary,
    active: d.active,
    endedAt: d.endedAt,
    country: d.country,
    createdBy: d.createdBy,
    updatedBy: d.updatedBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
