/**
 * importBlockedTexts — spec 083, CA-11 / D-13: LINGUAGEM DE PESSOA. Renderiza (com o i18next REAL e o registro REAL) todos os textos
 * do aviso `ADMISSION_IMPORT_BLOCKED` e reprova se qualquer um tiver termo técnico, código, id ou `{{}}` sobrando (Gabriel, 02/11:
 * "uma mensagem amigável e intuitiva, não com termos técnicos").
 *
 * "Vincular"/"Vinculá" (verbo, é o rótulo da tela) é PERMITIDO: só os substantivos técnicos são barrados.
 */
import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import type { AdminNotification, ImportBlockedPayload } from '@infrastructure/http/AdminNotificationApiService';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { getNotificationTypeHandler } from '../notificationTypeRegistry';

type Tree = { [k: string]: string | Tree };
function flattenLeaves(tree: Tree, prefix = ''): Array<[string, string]> {
  return Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v] as [string, string]] : flattenLeaves(v, `${prefix}${k}.`)));
}

export const FORBIDDEN_TERMS = [
  'import', 'importação', 'importar', 'no_link', 'wrong_account', 'blocked', 'expired', 'reason', 'stage', 'payload',
  'appointment', 'link', 'vínculo', 'vinculación', 'token', 'oauth', 'mcp', 'job', 'rodada', 'fila', 'evento', 'status', 'error', 'erro',
];

/** Palavra INTEIRA, sem caixa (lookaround em vez de `\b`: `\b` não entende acento e "import_blocked" tem de casar "import"). */
const TERM_RES = FORBIDDEN_TERMS.map((term) => ({ term, re: new RegExp(`(?<![\\p{L}\\p{N}])${term}(?![\\p{L}\\p{N}])`, 'iu') }));
const PATTERN_RES: Array<{ term: string; re: RegExp }> = [
  { term: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-/i },
  { term: 'codigo-adm', re: /ADM-[0-9A-Z]{6}/ },
  { term: 'placeholder-sobrando', re: /\{\{|\}\}/ },
  { term: 'numero-de-id', re: /\d{5,}/ },
  { term: 'iso-cru', re: /\d{4}-\d{2}-\d{2}/ },
];

export function findForbidden(text: string): string[] {
  return [...TERM_RES, ...PATTERN_RES].filter(({ re }) => re.test(text)).map(({ term }) => term);
}

const HOST_NAME = 'Marina Gómez';
const MEETING_AT = '2026-11-04T17:00:00.000Z';
const DEADLINE_AT = '2026-11-06T17:00:00.000Z';

function notif(payload: ImportBlockedPayload): AdminNotification {
  return {
    id: 'n1', typeCode: 'ADMISSION_IMPORT_BLOCKED', actorUid: 'system:admission', actorDisplayName: null, patientId: null,
    patientDisplayName: null, conversationId: null, messageId: null, rootMessageId: null, messageExcerpt: null,
    payload, createdAt: '2026-11-03T12:00:00.000Z', readAt: null,
  };
}

const kinds = ['admission', 'enquadre'] as const;
const reasons = ['no_link', 'wrong_account'] as const;
const base = { meetingAt: MEETING_AT, deadlineAt: DEADLINE_AT };

const payloads: ImportBlockedPayload[] = [
  ...(['blocked', 'reminder', 'expired'] as const).flatMap((stage) =>
    kinds.flatMap((kind) => reasons.map((reason) => ({ ...base, stage, kind, reason, audience: 'host' as const }))),
  ),
  ...kinds.flatMap((kind) =>
    reasons.flatMap((reason) => [
      { ...base, stage: 'will_be_lost' as const, kind, reason, audience: 'supervisor' as const, hostName: HOST_NAME },
      { ...base, stage: 'will_be_lost' as const, kind, reason, audience: 'supervisor' as const },
    ]),
  ),
];

async function makeT(lng: 'es' | 'pt-BR') {
  const json = lng === 'es' ? esJson : ptBRJson;
  const i18n = i18next.createInstance();
  await i18n.init({
    lng,
    resources: { [lng]: { translation: { admin: { notifications: json.admin.notifications, patients: { detail: { conversation: { thread: json.admin.patients.detail.conversation.thread } } } } } } },
    interpolation: { escapeValue: false },
  });
  return i18n.t.bind(i18n) as never;
}

/** Todas as folhas de TEXTO que a pessoa pode ver: título+corpo (aria), corpo (linha 3), ação (linha 2), autor (linha 1). */
async function renderAll(lng: 'es' | 'pt-BR'): Promise<Array<[string, string]>> {
  const t = await makeT(lng);
  const h = getNotificationTypeHandler('ADMISSION_IMPORT_BLOCKED');
  return payloads.flatMap((p) => {
    const n = notif(p);
    const id = `${lng}/${p.audience}/${p.stage}/${p.kind}/${p.reason}/${p.hostName ? 'com-nome' : 'sem-nome'}`;
    return [
      [`${id}/aria`, h.buildText(n, t)],
      [`${id}/corpo`, h.detailLine?.(n, t) ?? ''],
      [`${id}/acao`, h.contextLine?.(n, t) ?? ''],
      [`${id}/autor`, h.actorLabel?.(n, t) ?? ''],
    ] as Array<[string, string]>;
  });
}

describe('importBlocked — linguagem de pessoa (CA-11)', () => {
  it('autoteste dos DOIS lados: o detector acusa o ruim e deixa passar o bom', () => {
    expect(findForbidden('import_blocked')).not.toEqual([]);
    expect(findForbidden('ADM-7K3Q9P')).not.toEqual([]);
    expect(findForbidden('Importação bloqueada (no_link)')).not.toEqual([]);
    expect(findForbidden('{{data}}')).not.toEqual([]);
    expect(findForbidden('Não conseguimos trazer a transcrição. Toque em Vincular Tactiq.')).toEqual([]);
    expect(findForbidden('Vinculá tu cuenta en Mi perfil')).toEqual([]);
  });

  it.each(['es', 'pt-BR'] as const)('%s: nenhum texto renderizado tem termo técnico, código, id ou {{}} sobrando', async (lng) => {
    const folhas = await renderAll(lng);
    expect(folhas.length).toBe(payloads.length * 4); // controle positivo: 20 payloads × 4 linhas
    console.info(`FOLHAS_VERIFICADAS ${lng}=${folhas.length}`);
    expect(folhas.every(([, text]) => text.length > 0)).toBe(true);
    const violacoes = folhas.map(([id, text]) => ({ id, achou: findForbidden(text) })).filter((x) => x.achou.length > 0);
    expect(violacoes).toEqual([]);
  });

  it.each(['es', 'pt-BR'] as const)('%s: as folhas CRUAS da árvore importBlocked (com {{}} ainda por preencher) também não têm termo técnico', (lng) => {
    const json = (lng === 'es' ? esJson : ptBRJson).admin.notifications as unknown as { importBlocked: Tree };
    const folhas = flattenLeaves(json.importBlocked);
    expect(folhas.length).toBeGreaterThan(10);
    const violacoes = folhas
      .map(([id, text]) => ({ id, achou: findForbidden(text.replace(/\{\{\s*\w+\s*\}\}/g, '')) }))
      .filter((x) => x.achou.length > 0);
    expect(violacoes).toEqual([]);
  });

  it('a cópia do supervisor mostra o nome do host; sem nome usa a frase "a pessoa responsável" / "la persona responsable"', async () => {
    const h = getNotificationTypeHandler('ADMISSION_IMPORT_BLOCKED');
    const p: ImportBlockedPayload = { ...base, stage: 'will_be_lost', kind: 'admission', reason: 'no_link', audience: 'supervisor' };
    for (const [lng, fallback] of [['pt-BR', 'a pessoa responsável'], ['es', 'la persona responsable']] as const) {
      const t = await makeT(lng);
      expect(h.detailLine?.(notif({ ...p, hostName: HOST_NAME }), t)).toContain(HOST_NAME);
      expect(h.detailLine?.(notif({ ...p, hostName: HOST_NAME }), t)).not.toContain(fallback);
      expect(h.detailLine?.(notif(p), t)).toContain(fallback);
    }
  });
});
