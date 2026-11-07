import { describe, it, expect } from 'vitest';
import type { SavedCandidate } from '../../../../../types/match';
import {
  alreadyInVacancy,
  applyDocOnly,
  bandIndexOf,
  buildBoardView,
  dayInZone,
  docsLine,
  finishSummary,
  fitRadiusKmOf,
  inviteBadge,
  matchResult,
  openingStep,
  parseStep,
  selectedIds,
  setAllSelected,
  stepCandidates,
  stepFooter,
  stepGuide,
  stepPins,
  stepRings,
  stepSummaries,
  stepSummary,
  toggleOne,
  vacanteNote,
  type BoardContext,
} from '../inviteBoardModel';

let seq = 0;
function cand(over: Partial<SavedCandidate> & { id: string }): SavedCandidate {
  const { id, ...rest } = over;
  seq += 1;
  return {
    workerId: id,
    workerName: `Worker ${id}`,
    workerPhone: null,
    occupation: 'AT',
    workZone: null,
    distanceKm: 1,
    lat: -34.6 + seq / 1000,
    lng: -58.4,
    activeCasesCount: 0,
    workerStatus: null,
    documentStatus: 'approved',
    source: 'system',
    funnelStage: 'INVITED',
    replied: false,
    matchScore: null,
    internalNotes: null,
    alreadyApplied: false,
    messagedAt: null,
    ...rest,
  };
}

function ctxOf(candidates: SavedCandidate[], currentIds: string[], over: Partial<BoardContext> = {}): BoardContext {
  return {
    candidates,
    currentIds: new Set(currentIds),
    docOnly: false,
    unselected: new Set(),
    ...over,
  };
}

const ids = (cs: SavedCandidate[]) => cs.map((c) => c.workerId);

describe('bandas (min, max]', () => {
  it('d=5 vai na banda 0-5 e NÃO na 5-10; d=5.0001 vai na 5-10', () => {
    expect(bandIndexOf(5)).toBe(0);
    expect(bandIndexOf(5.0001)).toBe(1);
    const cs = [cand({ id: 'a', distanceKm: 5 }), cand({ id: 'b', distanceKm: 5.0001 })];
    const ctx = ctxOf(cs, ['a', 'b']);
    expect(ids(stepCandidates(ctx, 5))).toEqual(['a']);
    expect(ids(stepCandidates(ctx, 10))).toEqual(['b']);
  });

  it('fronteiras 10, 20, 50 pertencem à banda de baixo; > 50 e sem distância ficam fora', () => {
    expect([bandIndexOf(10), bandIndexOf(20), bandIndexOf(50)]).toEqual([1, 2, 3]);
    expect(bandIndexOf(50.01)).toBeNull();
    expect(bandIndexOf(null)).toBeNull();
    expect(bandIndexOf(0)).toBe(0);
  });

  it('candidato sem distância não aparece em nenhum passo de distância', () => {
    const ctx = ctxOf([cand({ id: 'x', distanceKm: null, lat: null, lng: null })], ['x']);
    for (const s of [5, 10, 20, 50] as const) expect(stepCandidates(ctx, s)).toEqual([]);
  });
});

describe('resultado do match e "Ya en la vacante" (⚑4)', () => {
  const cs = [
    cand({ id: 'in-result' }),
    cand({ id: 'manual-out', source: 'manual', distanceKm: 23.4 }),
    cand({ id: 'system-old', source: 'system', distanceKm: 61 }),
    cand({ id: 'no-loc', source: 'manual', distanceKm: null, lat: null, lng: null }),
    cand({ id: 'sent', source: 'manual', messagedAt: '2026-11-03T12:00:00Z' }),
    cand({ id: 'replied', source: 'manual', replied: true }),
    cand({ id: 'other-stage', source: 'manual', funnelStage: 'QUALIFIED' }),
  ];

  it('resultado = workerId ∈ currentIds', () => {
    expect(ids(matchResult(cs, new Set(['in-result'])))).toEqual(['in-result']);
  });

  it('vacante exclui quem está no resultado, inclui sem localização e system fora do resultado', () => {
    const got = ids(alreadyInVacancy(cs, new Set(['in-result'])));
    expect(got).toEqual(['manual-out', 'system-old', 'no-loc']);
  });

  it('quem está no resultado atual NÃO é "Ya en la vacante" mesmo INVITED sem WhatsApp', () => {
    expect(ids(alreadyInVacancy(cs, new Set(['in-result', 'manual-out'])))).not.toContain('manual-out');
    expect(ids(alreadyInVacancy(cs, new Set(['in-result', 'manual-out'])))).not.toContain('in-result');
  });

  it('exclui já enviado, com resposta e etapa diferente de INVITED', () => {
    const got = ids(alreadyInVacancy(cs, new Set()));
    expect(got).not.toContain('sent');
    expect(got).not.toContain('replied');
    expect(got).not.toContain('other-stage');
  });
});

describe('passo de abertura', () => {
  const cs = [cand({ id: 'v', source: 'manual', documentStatus: 'pending' }), cand({ id: 'r' })];

  it('vacante se há visíveis; senão 5', () => {
    expect(openingStep(ctxOf(cs, ['r']))).toBe('vacante');
    expect(openingStep(ctxOf([cs[1]], ['r']))).toBe(5);
  });

  it('o interruptor conta: só havia "faltan documentos" na vacante → abre no 5', () => {
    expect(openingStep(ctxOf(cs, ['r'], { docOnly: true }))).toBe(5);
  });

  it('?paso= válido vence; inválido cai na regra', () => {
    expect(openingStep(ctxOf(cs, ['r']), '20')).toBe(20);
    expect(openingStep(ctxOf([cs[1]], ['r']), 'vacante')).toBe('vacante');
    expect(openingStep(ctxOf(cs, ['r']), '7')).toBe('vacante');
    expect(openingStep(ctxOf([cs[1]], ['r']), 'abc')).toBe(5);
    expect(parseStep(null)).toBeNull();
    expect(parseStep('')).toBeNull();
  });
});

describe('anéis e enquadramento', () => {
  const cs = [cand({ id: 'a', distanceKm: 2 }), cand({ id: 'b', distanceKm: 7 }), cand({ id: 'c', distanceKm: 12 })];

  it('passo vacante: 4 anéis idle e fit 50', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'c']);
    expect(stepRings(ctx, 'vacante')).toEqual([
      { radiusKm: 5, tone: 'idle' },
      { radiusKm: 10, tone: 'idle' },
      { radiusKm: 20, tone: 'idle' },
      { radiusKm: 50, tone: 'idle' },
    ]);
    expect(fitRadiusKmOf('vacante')).toBe(50);
  });

  it('passo 10: anéis 5 e 10; 10 = current; 5 = idle se pendente, done se concluído', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'c']);
    expect(stepRings(ctx, 10)).toEqual([
      { radiusKm: 5, tone: 'idle' },
      { radiusKm: 10, tone: 'current' },
    ]);
    const done = ctxOf(cs, ['a', 'b', 'c'], { sent: { '5': 1 } });
    expect(stepRings(done, 10)[0].tone).toBe('done');
    expect(fitRadiusKmOf(10)).toBe(10);
  });

  it('anel de banda com 0 pendentes visíveis é done', () => {
    const ctx = ctxOf([cand({ id: 'only-far', distanceKm: 15 })], ['only-far']);
    expect(stepRings(ctx, 10)[0].tone).toBe('done');
  });

  it('anel do passo atual concluído (E5.4) vira done', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'c'], { sent: { '5': 1 } });
    expect(stepRings(ctx, 5)).toEqual([{ radiusKm: 5, tone: 'done' }]);
  });
});

describe('concluído e cartões de passo', () => {
  it('concluído ⇔ envio nesta visita OU 0 pendentes visíveis', () => {
    const cs = [cand({ id: 'a', distanceKm: 2 }), cand({ id: 'b', distanceKm: 3 })];
    expect(stepSummary(ctxOf(cs, ['a', 'b']), 5, 5).completed).toBe(false);
    expect(stepSummary(ctxOf(cs, ['a', 'b'], { sent: { '5': 2 } }), 5, 5).completed).toBe(true);
    const all = [cand({ id: 'a', distanceKm: 2, messagedAt: '2026-11-03T12:00:00Z' })];
    expect(stepSummary(ctxOf(all, ['a']), 5, 5).completed).toBe(true);
    expect(stepSummary(ctxOf([], []), 10, 5).completed).toBe(true);
  });

  it('só pendentes escondidos pelo interruptor também concluem o passo', () => {
    const cs = [cand({ id: 'a', distanceKm: 2, documentStatus: 'pending' })];
    expect(stepSummary(ctxOf(cs, ['a']), 5, 5).completed).toBe(false);
    expect(stepSummary(ctxOf(cs, ['a'], { docOnly: true }), 5, 5).completed).toBe(true);
  });

  it('subtítulos: sem WhatsApp (vacante) / por invitar / invitados', () => {
    const cs = [
      cand({ id: 'v', source: 'manual' }),
      cand({ id: 'a', distanceKm: 2 }),
      cand({ id: 'b', distanceKm: 3, messagedAt: '2026-11-03T12:00:00Z' }),
      cand({ id: 'c', distanceKm: 8 }),
    ];
    const s = stepSummaries(ctxOf(cs, ['a', 'b', 'c']), 'vacante');
    const by = (k: string) => s.find((x) => String(x.step) === k)!;
    expect(by('vacante')).toMatchObject({ tone: 'current', sub: { key: 'withoutWhatsapp', count: 1 } });
    expect(by('5')).toMatchObject({ tone: 'idle', sub: { key: 'toInvite', count: 1 }, total: 2, invited: 1 });
    expect(by('10').sub).toEqual({ key: 'toInvite', count: 1 });
    expect(by('20')).toMatchObject({ completed: true, tone: 'done' });
  });

  it('vacante fora do passo atual e pendente = amarelo; concluída mostra o enviado nesta visita', () => {
    const cs = [cand({ id: 'v', source: 'manual' })];
    expect(stepSummary(ctxOf(cs, []), 'vacante', 5).tone).toBe('pending-vacante');
    const after = stepSummary(ctxOf([], [], { sent: { vacante: 3 } }), 'vacante', 5);
    expect(after).toMatchObject({ tone: 'done', visible: true, sub: { key: 'invited', count: 3 } });
    expect(stepSummary(ctxOf([], []), 'vacante', 5).visible).toBe(false);
  });

  it('concluído mostra max(convidados no passo, enviados nesta visita)', () => {
    const cs = [
      cand({ id: 'a', distanceKm: 2, messagedAt: '2026-11-03T12:00:00Z' }),
      cand({ id: 'b', distanceKm: 3, messagedAt: '2026-11-06T12:00:00Z' }),
    ];
    expect(stepSummary(ctxOf(cs, ['a', 'b'], { sent: { '5': 1 } }), 5, 5).sub).toEqual({ key: 'invited', count: 2 });
  });
});

describe('pinos', () => {
  const cs = [
    cand({ id: 'in5', distanceKm: 3 }),
    cand({ id: 'in5-off', distanceKm: 4 }),
    cand({ id: 'in5-inv', distanceKm: 4.5, messagedAt: '2026-11-03T12:00:00Z' }),
    cand({ id: 'in10', distanceKm: 8 }),
    cand({ id: 'in20', distanceKm: 15 }),
    cand({ id: 'noloc', distanceKm: null, lat: null, lng: null }),
  ];

  it('passo 10: pinos até 10 km; banda atual 18 px, interna 12 px; cores por estado', () => {
    const ctx = ctxOf(cs, cs.map((c) => c.workerId), { unselected: new Set(['in5-off']) });
    const pins = Object.fromEntries(stepPins(ctx, 10).map((p) => [p.workerId, p]));
    expect(Object.keys(pins).sort()).toEqual(['in10', 'in5', 'in5-inv', 'in5-off']);
    expect(pins.in10.style).toMatchObject({ fill: '#F227AF', stroke: '#ffffff', sizePx: 18 });
    expect(pins.in5.style).toMatchObject({ fill: '#180149', sizePx: 12 });
    expect(pins['in5-inv'].style).toMatchObject({ fill: '#ffffff', stroke: '#737373', sizePx: 12 });
    expect(pins['in5-off'].tone).toBe('unselected');
  });

  it('passo 5: elegido rosa 18, não elegido navy 18, convidado branco', () => {
    const ctx = ctxOf(cs, cs.map((c) => c.workerId), { unselected: new Set(['in5-off']) });
    const pins = Object.fromEntries(stepPins(ctx, 5).map((p) => [p.workerId, p]));
    expect(pins.in5.style).toMatchObject({ fill: '#F227AF', sizePx: 18 });
    expect(pins['in5-off'].style).toMatchObject({ fill: '#180149', sizePx: 18 });
    expect(pins['in5-inv'].tone).toBe('invited');
  });

  it('enfatizado = 24 px com outline', () => {
    const ctx = ctxOf(cs, cs.map((c) => c.workerId), { emphasizedId: 'in5' });
    expect(stepPins(ctx, 5).find((p) => p.workerId === 'in5')!.style).toMatchObject({ sizePx: 24, outline: true });
  });

  it('passo vacante: só visíveis localizados ≤ 50 km (Rosa sim; Carla > 50 e Nadia sem ubicación não)', () => {
    const v = [
      cand({ id: 'rosa', source: 'manual', distanceKm: 23.4 }),
      cand({ id: 'carla', source: 'manual', distanceKm: 61 }),
      cand({ id: 'nadia', source: 'manual', distanceKm: null, lat: null, lng: null }),
    ];
    const ctx = ctxOf(v, []);
    const pins = stepPins(ctx, 'vacante');
    expect(ids(pins as unknown as SavedCandidate[])).toEqual(['rosa']);
    expect(pins[0].style).toMatchObject({ fill: '#F227AF', sizePx: 18 });
    expect(vacanteNote(ctx, 'vacante')).toEqual({ farCount: 1, noLocationCount: 1 });
    expect(vacanteNote(ctx, 5)).toBeNull();
  });
});

describe('pré-seleção', () => {
  const cs = [
    cand({ id: 'a', distanceKm: 1 }),
    cand({ id: 'b', distanceKm: 2 }),
    cand({ id: 'inv', distanceKm: 3, messagedAt: '2026-11-03T12:00:00Z' }),
    cand({ id: 'c', distanceKm: 4, documentStatus: 'pending' }),
  ];

  it('pendentes visíveis do passo, sem convidados (nem caixa), menos desmarcados', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'inv', 'c']);
    expect(selectedIds(ctx, 5)).toEqual(['a', 'b', 'c']);
    expect(selectedIds({ ...ctx, unselected: new Set(['b']) }, 5)).toEqual(['a', 'c']);
    const rows = buildBoardView(ctx, 5).rows;
    const inv = rows.find((r) => r.candidate.workerId === 'inv')!;
    expect(inv).toMatchObject({ invited: true, selectable: false, selected: false });
  });

  it('vacante: toda a lista (inclusive sem ubicación) vem pré-selecionada', () => {
    const v = [
      cand({ id: 'p', source: 'manual', distanceKm: 20 }),
      cand({ id: 'q', source: 'manual', distanceKm: null, lat: null, lng: null }),
    ];
    expect(selectedIds(ctxOf(v, []), 'vacante')).toEqual(['p', 'q']);
  });

  it('toggleOne e "Todos"', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'inv', 'c']);
    const none = setAllSelected(ctx, 5, false);
    expect([...none].sort()).toEqual(['a', 'b', 'c']);
    expect(selectedIds({ ...ctx, unselected: none }, 5)).toEqual([]);
    expect([...setAllSelected({ ...ctx, unselected: none }, 5, true)]).toEqual([]);
    expect([...toggleOne(new Set(['a']), 'a')]).toEqual([]);
    expect([...toggleOne(new Set(), 'a')]).toEqual(['a']);
  });

  it('resumo: "Todos" marcada/desabilitada e "Todos ya invitados"', () => {
    const ctx = ctxOf(cs, ['a', 'b', 'inv', 'c']);
    expect(buildBoardView(ctx, 5).selection).toMatchObject({ selected: 3, pending: 3, allChecked: true, allInvited: false });
    expect(buildBoardView({ ...ctx, unselected: new Set(['a']) }, 5).selection.allChecked).toBe(false);
    const done = ctxOf([cand({ id: 'z', distanceKm: 1, messagedAt: '2026-11-03T12:00:00Z' })], ['z']);
    expect(buildBoardView(done, 5).selection).toMatchObject({ allInvited: true, allDisabled: true });
  });
});

describe('interruptor "Solo con documentos completos" (DF-16/DF-17)', () => {
  const cs = [
    cand({ id: 'ok-approved', distanceKm: 1, documentStatus: 'approved' }),
    cand({ id: 'ok-submitted', distanceKm: 2, documentStatus: 'submitted' }),
    cand({ id: 'ok-review', distanceKm: 3, documentStatus: 'under_review' }),
    cand({ id: 'no-pending', distanceKm: 4, documentStatus: 'pending' }),
    cand({ id: 'no-rejected', distanceKm: 4.5, documentStatus: 'rejected' }),
    cand({ id: 'no-null', distanceKm: 4.8, documentStatus: null }),
    cand({ id: 'later', distanceKm: 8, documentStatus: 'incomplete' }),
  ];
  const all = cs.map((c) => c.workerId);

  it('ligar esconde (lista, pinos, contagens) e desmarca os escondidos', () => {
    const off = ctxOf(cs, all);
    const { docOnly, unselected } = applyDocOnly(true, off.unselected, cs);
    const on: BoardContext = { ...off, docOnly, unselected };
    expect(ids(stepCandidates(on, 5))).toEqual(['ok-approved', 'ok-submitted', 'ok-review']);
    expect(stepPins(on, 5).map((p) => p.workerId)).toEqual(['ok-approved', 'ok-submitted', 'ok-review']);
    expect(selectedIds(on, 5)).toEqual(['ok-approved', 'ok-submitted', 'ok-review']);
    expect(docsLine(off, 5)).toEqual({ mode: 'off', complete: 3, missing: 3 });
    expect(docsLine(on, 5)).toEqual({ mode: 'on', complete: 3, missing: 3 });
    expect(stepSummary(on, 5, 5)).toMatchObject({ pending: 3, total: 3 });
    expect(stepSummary(off, 5, 5)).toMatchObject({ pending: 6, total: 6 });
    expect(stepSummary(on, 10, 5)).toMatchObject({ pending: 0, completed: true });
    expect(stepFooter(on, 5).more).toEqual({ km: 10, count: 0 });
    expect(stepFooter(off, 5).more).toEqual({ km: 10, count: 1 });
    expect(stepFooter(on, 5).selectedCount).toBe(3);
  });

  it('desligar NÃO re-seleciona: os que voltam estão desmarcados', () => {
    const on = applyDocOnly(true, new Set(), cs);
    const off = applyDocOnly(false, on.unselected, cs);
    const ctx: BoardContext = { ...ctxOf(cs, all), docOnly: off.docOnly, unselected: off.unselected };
    expect(ids(stepCandidates(ctx, 5))).toHaveLength(6);
    expect(selectedIds(ctx, 5)).toEqual(['ok-approved', 'ok-submitted', 'ok-review']);
  });

  it('vale para a vacante e "sin ubicación" também', () => {
    const v = [
      cand({ id: 'v-ok', source: 'manual', distanceKm: null, lat: null, lng: null }),
      cand({ id: 'v-no', source: 'manual', distanceKm: null, lat: null, lng: null, documentStatus: null }),
    ];
    const ctx = ctxOf(v, [], { docOnly: true });
    expect(ids(stepCandidates(ctx, 'vacante'))).toEqual(['v-ok']);
    expect(vacanteNote(ctx, 'vacante')).toEqual({ farCount: 0, noLocationCount: 1 });
  });
});

describe('rodapé', () => {
  const cs = [cand({ id: 'a', distanceKm: 1 }), cand({ id: 'b', distanceKm: 2 }), cand({ id: 'n', distanceKm: 7 })];
  const base = ctxOf(cs, ['a', 'b', 'n']);

  it('invite: ≥1 elegido, com N do "Buscar más lejos"', () => {
    expect(stepFooter(base, 5)).toEqual({ mode: 'invite', selectedCount: 2, pendingCount: 2, more: { km: 10, count: 1 } });
  });

  it('empty: pendentes, 0 elegidos', () => {
    const none = { ...base, unselected: new Set(['a', 'b']) };
    expect(stepFooter(none, 5)).toMatchObject({ mode: 'empty', selectedCount: 0, pendingCount: 2 });
  });

  it('after: enviado nesta visita ou 0 pendentes', () => {
    expect(stepFooter({ ...base, sent: { '5': 2 } }, 5).mode).toBe('after');
    expect(stepFooter(ctxOf([], []), 10).mode).toBe('after');
  });

  it('último passo: concluído = last (só Terminar); com pendentes não há "más lejos"', () => {
    const far = ctxOf([cand({ id: 'f', distanceKm: 30 })], ['f']);
    expect(stepFooter(far, 50)).toMatchObject({ mode: 'invite', more: null });
    expect(stepFooter({ ...far, sent: { '50': 1 } }, 50).mode).toBe('last');
  });

  it('passo vacante: "más lejos" aponta para 5 km com o N da banda 0-5', () => {
    const v = ctxOf([cand({ id: 'v', source: 'manual' }), cand({ id: 'a', distanceKm: 1 })], ['a']);
    expect(stepFooter(v, 'vacante').more).toEqual({ km: 5, count: 1 });
    expect(stepFooter(v, 'vacante').mode).toBe('invite');
  });
});

describe('título e guia', () => {
  it('chaves de título e guia por passo/estado', () => {
    const ctx = ctxOf([cand({ id: 'a', distanceKm: 1 }), cand({ id: 'v', source: 'manual' })], ['a']);
    expect(buildBoardView(ctx, 'vacante').title.kind).toBe('vacante');
    expect(buildBoardView(ctx, 5).title).toEqual({ kind: 'upTo', min: 0, max: 5 });
    expect(buildBoardView(ctx, 20).title).toEqual({ kind: 'between', min: 10, max: 20 });
    expect(stepGuide(ctx, 'vacante')).toBe('vacantePending');
    expect(stepGuide({ ...ctx, sent: { vacante: 1 } }, 'vacante')).toBe('vacanteDone');
    expect(stepGuide(ctx, 5)).toBe('firstStep');
    expect(stepGuide(ctxOf([cand({ id: 'b', distanceKm: 7 })], ['b']), 10)).toBe('nextStep');
    expect(stepGuide({ ...ctx, sent: { '5': 1 } }, 5)).toBe('doneMore');
    expect(stepGuide({ ...ctx, sent: { '50': 1 } }, 50)).toBe('doneLast');
  });

  it('⚑7: nota "Solo aparecen prestadores…" escondida só no passo vacante', () => {
    const ctx = ctxOf([], []);
    expect(buildBoardView(ctx, 'vacante').showProfileNote).toBe(false);
    expect(buildBoardView(ctx, 5).showProfileNote).toBe(true);
  });
});

describe('dia/fuso e F5 (DF-20)', () => {
  it('instante 02:30 UTC de 06/11 = 05/11 em Buenos Aires: "hoy" com operationDate 05/11', () => {
    const iso = '2026-11-06T02:30:00Z';
    expect(dayInZone(iso, 'America/Argentina/Buenos_Aires')).toBe('2026-11-05');
    expect(dayInZone(iso, 'UTC')).toBe('2026-11-06');
    const c = cand({ id: 'h', messagedAt: iso });
    expect(inviteBadge(c, '2026-11-05', 'America/Argentina/Buenos_Aires')).toEqual({ kind: 'today' });
    expect(inviteBadge(c, '2026-11-06', 'America/Argentina/Buenos_Aires')).toEqual({ kind: 'on', dayMonth: '05/11' });
  });

  it('dd/MM no fuso do país e sem timeZone = fuso do operador', () => {
    const c = cand({ id: 'x', messagedAt: '2026-11-03T12:00:00Z' });
    expect(inviteBadge(c, '2026-11-06')).toEqual({ kind: 'on', dayMonth: '03/11' });
    expect(inviteBadge(cand({ id: 'y' }), '2026-11-06')).toBeNull();
    expect(inviteBadge(cand({ id: 'z', messagedAt: 'lixo' }), '2026-11-06')).toBeNull();
  });

  it('F5: agrupa por vacante / faixas / sin ubicación; faixa 0 some; só messagedAt no operationDate', () => {
    const today = '2026-11-06T15:00:00Z';
    const cs = [
      cand({ id: 'v1', source: 'manual', messagedAt: today, distanceKm: 23.4 }),
      cand({ id: 'v2', source: 'manual', messagedAt: today, distanceKm: null, lat: null, lng: null }),
      cand({ id: 'a', distanceKm: 3, messagedAt: today }),
      cand({ id: 'b', distanceKm: 5.5, messagedAt: today }),
      cand({ id: 'c', distanceKm: 9, messagedAt: today }),
      cand({ id: 'old', distanceKm: 2, messagedAt: '2026-11-03T12:00:00Z' }),
      cand({ id: 'never', distanceKm: 2 }),
      cand({ id: 'nd', distanceKm: null, lat: null, lng: null, messagedAt: today }),
    ];
    const r = finishSummary(cs, new Set(['a', 'b', 'c', 'old', 'never', 'nd']), '2026-11-06');
    expect(r).toEqual({
      total: 6,
      vacante: 2,
      bands: [
        { min: 0, max: 5, count: 1 },
        { min: 5, max: 10, count: 2 },
      ],
      noLocation: 1,
    });
  });

  it('F5: 02:30 UTC pertence ao dia anterior do país', () => {
    const cs = [cand({ id: 'a', distanceKm: 3, messagedAt: '2026-11-06T02:30:00Z' })];
    expect(finishSummary(cs, new Set(['a']), '2026-11-05', 'America/Argentina/Buenos_Aires').total).toBe(1);
    expect(finishSummary(cs, new Set(['a']), '2026-11-06', 'America/Argentina/Buenos_Aires').total).toBe(0);
  });
});
