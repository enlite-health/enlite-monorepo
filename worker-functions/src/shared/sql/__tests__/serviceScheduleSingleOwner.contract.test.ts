/**
 * Controle mecânico da spec 056 (Horas com dono único): NENHUM código lê ou escreve
 * `patient_contracted_services.schedule`. O dono do horário do serviço são as faixas vigentes
 * (`patient_itinerary_slot`, lidas por `horario_do_servico`).
 *
 * Varre `worker-functions/src` (menos `__tests__` e `*.test.ts`) e reprova, EM CÓDIGO (linhas de comentário `//`, `*`
 * e `/*` são ignoradas): `pcs.schedule`, `pcs_eff.schedule`, `${eff}.schedule` (o alias interpolado do serviço) e
 * `SET schedule` em `patient_contracted_services`.
 *
 * LIMITE HONESTO: é regex sobre texto. NÃO vê alias com outro nome nem SQL montado dinamicamente; quem cobre isso
 * é o teste por EFEITO (`vacancyEffectiveFields.singleSource`), que não depende de regex.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../..'); // worker-functions/src

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const ALIAS_READ = /\b(pcs|pcs_eff)\.schedule\b|\$\{\s*eff\s*\}\.schedule\b/;
const SET_SCHEDULE = /\bSET\s+schedule\b/i;

interface Hit {
  file: string;
  line: number;
  text: string;
}

export function findScheduleOfServiceUsages(source: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    if (isComment(text)) return;
    if (ALIAS_READ.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    // `SET schedule` só é do serviço se a query fala de `patient_contracted_services` (vaga tem a própria coluna).
    if (SET_SCHEDULE.test(text)) {
      const window = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
      if (/patient_contracted_services/.test(window)) hits.push({ file, line: i + 1, text: text.trim() });
    }
  });
  return hits;
}

describe('serviceScheduleSingleOwner — o horário do serviço tem UM dono (as faixas)', () => {
  it('nenhum leitor/escritor de patient_contracted_services.schedule', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100); // controle positivo: a varredura enxerga o src
    const hits = files.flatMap((f) =>
      findScheduleOfServiceUsages(fs.readFileSync(f, 'utf8'), path.relative(SRC, f)),
    );
    const report = hits.map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(report).toEqual([]);
  });

  it('o detector pega SQL real e ignora comentário (controle positivo do instrumento)', () => {
    expect(findScheduleOfServiceUsages('SELECT pcs.schedule FROM patient_contracted_services pcs', 'x.ts')).toHaveLength(1);
    expect(findScheduleOfServiceUsages('SELECT pcs_eff.schedule FROM x', 'x.ts')).toHaveLength(1);
    expect(findScheduleOfServiceUsages('SELECT ${eff}.schedule FROM x', 'x.ts')).toHaveLength(1);
    expect(findScheduleOfServiceUsages('UPDATE patient_contracted_services\n   SET schedule = $2', 'x.ts')).toHaveLength(1);
    expect(findScheduleOfServiceUsages('// lia pcs.schedule antes', 'x.ts')).toHaveLength(0);
    expect(findScheduleOfServiceUsages(' * antes: ${eff}.schedule', 'x.ts')).toHaveLength(0);
    expect(findScheduleOfServiceUsages('UPDATE job_postings SET schedule = $1', 'x.ts')).toHaveLength(0);
  });
});
