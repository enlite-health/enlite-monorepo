/**
 * Parte PURA do CLI da fusão rascunho→oficial (`fusao-rascunho-oficial.ts`): flags, leitura do mapa CSV e relatório.
 * Entra no piso de cobertura (mesma régua dos outros scripts com lógica pura); o orquestrador (Pool) fica fora.
 * O relatório só carrega IDs, etapas e contagens — nunca nome, telefone, e-mail ou texto.
 */
import type {
  FusionOutcome,
  FusionPair,
} from '../src/modules/case/application/FuseDraftIntoOfficialVacancyUseCase';
import { FUSION_COUNTED_TABLES, type FusionTable } from '../src/modules/case/infrastructure/DraftFusionRepository';

export type FusionMode = 'dry-run' | 'apply';

/** Exatamente um de `--dry-run` / `--apply`, e `--csv <arquivo>`. Sem modo explícito, recusa (nunca grava por omissão). */
export function parseFusionArgs(argv: readonly string[]): { mode: FusionMode; csv: string } {
  const dry = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  if (dry === apply) throw new Error('use exatamente um de --dry-run ou --apply');
  const i = argv.indexOf('--csv');
  const csv = i >= 0 ? argv[i + 1] : undefined;
  if (!csv || csv.startsWith('--')) throw new Error('faltou --csv <arquivo do mapa>');
  return { mode: apply ? 'apply' : 'dry-run', csv };
}

/** Uma linha CSV (RFC 4180: aspas duplas, "" escapa aspas). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUIRED = ['patient_id', 'rascunho_id', 'ativa_id', 'contracted_service_id', 'classe'] as const;

/** Só a classe PAR_UNICO entra. Coluna faltando ou id que não é UUID → erro (o mapa está errado, não se adivinha). */
export function parseFusionCsv(text: string): FusionPair[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('mapa vazio');
  const header = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(REQUIRED.map((c) => [c, header.indexOf(c)])) as Record<(typeof REQUIRED)[number], number>;
  const missing = REQUIRED.filter((c) => idx[c] < 0);
  if (missing.length > 0) throw new Error(`mapa sem coluna: ${missing.join(', ')}`);
  const pairs: FusionPair[] = [];
  lines.slice(1).forEach((line, n) => {
    const cols = splitCsvLine(line);
    if (cols[idx.classe] !== 'PAR_UNICO') return;
    const pair: FusionPair = {
      patientId: cols[idx.patient_id],
      draftId: cols[idx.rascunho_id],
      officialId: cols[idx.ativa_id],
      serviceId: cols[idx.contracted_service_id],
    };
    const bad = Object.entries(pair).find(([, v]) => !UUID.test(v));
    if (bad) throw new Error(`linha ${n + 2}: ${bad[0]} não é UUID`);
    pairs.push(pair);
  });
  return pairs;
}

export type PatientLine = { pair: FusionPair; outcome: FusionOutcome } | { pair: FusionPair; error: string };

/** Uma linha por paciente: só IDs, etapas e contagens antes→depois. */
export function formatPatientLine(line: PatientLine): string {
  const p = line.pair;
  const head = `paciente=${p.patientId} rascunho=${p.draftId} oficial=${p.officialId}`;
  if ('error' in line) return `${head} ERRO ${line.error}`;
  const o = line.outcome;
  if (o.status === 'SKIPPED') return `${head} PULADO ${o.reason}`;
  if (o.status === 'CONFLICT') {
    const c = o.conflicts.map((x) => `${x.workerId}:${x.officialStage}<>${x.draftStage}`).join(',');
    return `${head} CONFLITO ${c}`;
  }
  const r = o.result;
  const tables = FUSION_COUNTED_TABLES.map((t) => {
    const b = r.before[t];
    const a = r.after[t];
    return `${t}=${b.draft}+${b.official}->${a.draft}+${a.official}`;
  }).join(' ');
  const stages = Object.entries(r.collisionStages).map(([s, n]) => `${s}:${n}`).join(',');
  return `${head} FUNDIDO${o.committed ? '' : '(rollback)'} ${tables} colisoes=[${stages}] endereco_alinhado=${r.addressAligned} vigentes=${r.vigentesNoServico} sem_portao=[${r.gateWaived.join(',')}]`;
}

export interface FusionTotals {
  fused: number;
  skipped: Record<string, number>;
  conflicts: string[];
  errors: string[];
  /** antes = rascunho + oficial; depois = oficial; fundidas = linhas consolidadas por colisão. */
  tables: Record<FusionTable, { before: number; after: number; merged: number }>;
  collisionStages: Record<string, number>;
  /** Pacientes fundidos com dispensa do portão (campo vazio nos dois lados). */
  gateWaived: string[];
}

export function totalize(lines: readonly PatientLine[]): FusionTotals {
  const t: FusionTotals = {
    fused: 0,
    skipped: {},
    conflicts: [],
    errors: [],
    tables: Object.fromEntries(FUSION_COUNTED_TABLES.map((k) => [k, { before: 0, after: 0, merged: 0 }])) as FusionTotals['tables'],
    collisionStages: {},
    gateWaived: [],
  };
  for (const line of lines) {
    if ('error' in line) {
      t.errors.push(line.pair.patientId);
      continue;
    }
    const o = line.outcome;
    if (o.status === 'SKIPPED') {
      const key = o.reason.split(':')[0];
      t.skipped[key] = (t.skipped[key] ?? 0) + 1;
    } else if (o.status === 'CONFLICT') {
      t.conflicts.push(line.pair.patientId);
    } else {
      t.fused++;
      if (o.result.gateWaived.length > 0) t.gateWaived.push(line.pair.patientId);
      for (const k of FUSION_COUNTED_TABLES) {
        t.tables[k].before += o.result.before[k].draft + o.result.before[k].official;
        t.tables[k].after += o.result.after[k].draft + o.result.after[k].official;
        t.tables[k].merged += o.result.merged[k] ?? 0;
      }
      for (const [s, n] of Object.entries(o.result.collisionStages)) t.collisionStages[s] = (t.collisionStages[s] ?? 0) + n;
    }
  }
  return t;
}

export function formatTotals(t: FusionTotals, mode: FusionMode): string[] {
  return [
    `TOTAL modo=${mode} fundidos=${t.fused} pulados=${Object.values(t.skipped).reduce((a, b) => a + b, 0)} conflitos=${t.conflicts.length} erros=${t.errors.length}`,
    `pulados_por_motivo ${JSON.stringify(t.skipped)}`,
    `conflitos_pacientes ${t.conflicts.join(',') || '-'}`,
    `erros_pacientes ${t.errors.join(',') || '-'}`,
    'tabela | antes(rascunho+oficial) | depois(oficial) | fundidas',
    ...FUSION_COUNTED_TABLES.map((k) => `${k} | ${t.tables[k].before} | ${t.tables[k].after} | ${t.tables[k].merged}`),
    `colisoes_etapa_final ${JSON.stringify(t.collisionStages)}`,
    `fundidos_sem_portao_campos_vazios ${t.gateWaived.length} ${t.gateWaived.join(',') || '-'}`,
  ];
}
