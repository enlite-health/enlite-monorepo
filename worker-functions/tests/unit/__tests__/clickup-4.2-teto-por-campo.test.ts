/**
 * 4.2 — o teto por campo, e a trava que impede SQL e TypeScript de divergirem.
 *
 * ── Por que este arquivo existe ─────────────────────────────────────────────
 * A migration 306 deu teto **5** a `Tipo de Dispositivo` (catálogo de 5 opções, autorizado pelo
 * Gabriel em 25/08 condicionado a serem 5 — medido: são). Os demais campos seguem em 3.
 *
 * Isso cria DUAS declarações do mesmo limite: o `CHECK` no banco e
 * `PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO` no TypeScript. Duas listas escritas à mão divergem
 * em silêncio — é o F20/F49/F51 desta casa, que já mordeu 4× nesta change (mapas, satélites do
 * ABAC, OP-04.a, catálogos de teste). E aqui a divergência é das piores:
 *
 *   - TS mais ESTREITO que o banco ⇒ o 4º dispositivo é recusado pelo código com `reason:
 *     'ceiling'` e o operador não entende por quê, porque o banco aceitaria;
 *   - TS mais LARGO que o banco ⇒ o `INSERT` explode com `23514` no meio do sync, e a mensagem
 *     não diz de onde veio o número.
 *
 * ⇒ Este teste LÊ a migration e compara. Não é asserção sobre um valor: é asserção sobre as
 * duas fontes concordarem.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PATIENT_SOURCE_LABEL_CEILING,
  PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO,
  tetoDoCampo,
  classify,
} from '../../../src/modules/case/infrastructure/PatientSourceLabelRepository';

const MIGRATION = path.join(__dirname, '../../../migrations/309_device_type_sem_teto_no_cru.sql');

describe('4.2 — teto por campo: o SQL e o TypeScript dizem a MESMA coisa', () => {
  it('a migration 309 existe e declara o CHECK por campo', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
    const sql = fs.readFileSync(MIGRATION, 'utf-8');
    expect(sql).toContain('patient_source_labels_ceiling_por_campo');
  });

  it('⚠️ A TRAVA: campo SEM teto no TS aparece como isento no CHECK da migration', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf-8')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

    const semTeto = Object.entries(PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO)
      .filter(([, v]) => v === null).map(([k]) => k);
    console.log(`>>> 4.2/teto | sem teto no TS: ${JSON.stringify(semTeto)}`);
    expect(semTeto.length).toBeGreaterThan(0);          // contagem zero é "não mediu" (F19)

    for (const campo of semTeto) {
      // o CHECK isenta o campo com `field_name = '<campo>' OR ordinal <= N`
      const padrao = new RegExp(`field_name\\s*=\\s*'${campo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*OR`);
      console.log(`>>> 4.2/teto |   ${campo} isento no CHECK? ${padrao.test(sql)}`);
      expect(sql).toMatch(padrao);
    }

    const teto = sql.match(/ordinal\s*<=\s*(\d+)/);
    expect(teto).not.toBeNull();
    console.log(`>>> 4.2/teto | teto dos DEMAIS: TS=${PATIENT_SOURCE_LABEL_CEILING} SQL=${teto?.[1]}`);
    expect(Number(teto![1])).toBe(PATIENT_SOURCE_LABEL_CEILING);
  });

  it('CONTROLE POSITIVO: o CHECK NÃO carrega mais um número para dispositivo', () => {
    // Era `THEN 5` na 306. Se o número voltar, a contradição voltou: teto fixo espelhando
    // catálogo editável vira mentira no primeiro tipo novo criado pelo painel.
    const sql = fs.readFileSync(MIGRATION, 'utf-8');
    console.log(`>>> 4.2/controle | achou "THEN <numero>" no CHECK? ${/THEN\s*\d+/.test(sql.split('\n').filter(l=>!l.trim().startsWith('--')).join('\n'))}`);
    expect(sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')).not.toMatch(/THEN\s*\d+/);
  });

  it('`tetoDoCampo` devolve null para dispositivo e 3 para o resto', () => {
    console.log(`>>> 4.2/teto | dispositivo=${tetoDoCampo('Tipo de Dispositivo')} segmento=${tetoDoCampo('Segmentos Clínicos')}`);
    expect(tetoDoCampo('Tipo de Dispositivo')).toBeNull();
    expect(tetoDoCampo('Segmentos Clínicos')).toBe(PATIENT_SOURCE_LABEL_CEILING);
    expect(tetoDoCampo('Campo Que Não Existe')).toBe(PATIENT_SOURCE_LABEL_CEILING);
  });

  it('o EFEITO: 6 dispositivos passam (o catálogo é que limita); o 4º segmento é recusado', () => {
    const seis = ['a', 'b', 'c', 'd', 'e', 'f'];
    const disp = classify(seis, 'Tipo de Dispositivo');
    const seg  = classify(seis, 'Segmentos Clínicos');
    console.log(`>>> 4.2/efeito | dispositivo: aceitos=${disp.accepted.length} recusados=${disp.rejected.length}`);
    console.log(`>>> 4.2/efeito | segmento:    aceitos=${seg.accepted.length} recusados=${seg.rejected.length}`);

    // 6 > cardinalidade do catálogo de propósito: o cru NÃO é quem limita. Quem limita é a FK
    // de `patient_device_types`, que se ajusta sozinha quando o catálogo cresce.
    expect(disp.accepted).toHaveLength(6);
    expect(disp.rejected).toHaveLength(0);
    expect(seg.accepted).toHaveLength(3);
    expect(seg.rejected).toHaveLength(3);   // 6 mandados, 3 cabem
    expect(seg.rejected.every(r => r.reason === 'ceiling')).toBe(true);
  });

  it('CONTROLE NEGATIVO: sem o campo, cai no teto padrão — a isenção não vaza', () => {
    const cinco = ['a', 'b', 'c', 'd', 'e'];
    console.log(`>>> 4.2/negativo | sem fieldName: aceitos=${classify(cinco).accepted.length} (esperado 3)`);
    expect(classify(cinco).accepted).toHaveLength(PATIENT_SOURCE_LABEL_CEILING);
  });
});
