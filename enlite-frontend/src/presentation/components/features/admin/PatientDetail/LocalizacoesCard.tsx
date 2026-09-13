import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, Pencil } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { addressLines } from '@presentation/utils/summarizeAddress';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';
import { patientAddressTypeSchema } from '@domain/entities/PatientAddress';
import { PatientAddressDrawer } from './edit/PatientAddressDrawer';
import { AvisoAmbar } from './edit/AvisoAmbar';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

interface LocalizacoesCardProps {
  addresses: PatientAddressDetail[];
  /** Patient id — required to create/edit addresses from the ficha (spec 012, US-B2). */
  patientId?: string;
  /** Called after a successful create/edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta domicilio") — abre a criação. */
  focusRequest?: DrawerFocusRequest | null;
}

/**
 * O que a coluna Dirección mostra em 2 linhas — via `addressLines` (utils/summarizeAddress.ts),
 * a MESMA fronteira rua↔resto que `VacancyFormSection.tsx` já usa por `summarizeAddress`.
 * Achado do gate `revisao-pr`, 1ª rodada (BLOCKER): esta função tinha uma cópia local dessa
 * fronteira que divergia da de produção — apagada, a leitura vem do módulo compartilhado.
 * Achado da 2ª rodada (MINOR): chamar `streetLineOf` (linha 1) e `summarizeAddress` (linha 2)
 * em PARALELO sobre o mesmo texto fazia a linha 2 repetir a linha 1 quando nenhuma rua era
 * reconhecida (ex.: "Tigre, Provincia de Buenos Aires, Argentina" virava linha 1 "Tigre" +
 * linha 2 "Tigre, Provincia de Buenos Aires") e deixava o país sobrar sozinho na linha 2
 * ("Ruta 9 km 42, Argentina" → linha 2 "Argentina"). `addressLines` resolve as DUAS linhas
 * juntas, sabendo o que a linha 1 já consumiu — por isso a troca das duas chamadas por uma só.
 *
 * `neighborhood` continua tendo prioridade sobre o resumo calculado para a linha 2; `null` nas
 * duas quando o endereço não tem NEM formatado NEM cru (linha vira alerta) — "" conta como
 * ausente nos dois campos (`.trim()`), não só `null`/`undefined`.
 */
function splitAddressForDisplay(
  addr: Pick<PatientAddressDetail, 'addressFormatted' | 'addressRaw' | 'neighborhood'>,
): { line1: string | null; line2: string | null } {
  const formatted = (addr.addressFormatted ?? '').trim();
  const raw = (addr.addressRaw ?? '').trim();
  const full = formatted || raw || null;
  if (!full) return { line1: null, line2: null };

  const lines = addressLines(full);
  const line1 = lines.line1 || full;
  const line2 = addr.neighborhood ?? lines.line2;
  return { line1, line2 };
}

/**
 * `null`/`undefined` (`address_type` "sin especificar") e a lista fechada por parentesco (spec
 * 019) — MESMA validação do drawer (`patientAddressTypeSchema`, `PatientAddress.ts`): uma linha
 * legada com `'primary'`/`'secondary'`/`'service'` (não deveria sobrar em linha ATIVA depois da
 * migration 434, mas o card não confia sem checar) cai em "Sin especificar", igual ao <select>
 * do drawer — antes deste conserto o card mostrava "Principal"/"Secundária" para esses valores,
 * discordando do drawer (achado do gate `revisao-pr`).
 */
function typeLabel(t: TFunction, addressType: string | null): string {
  const parsed = patientAddressTypeSchema.parse(addressType);
  if (!parsed) return t('admin.patients.detail.locationsCard.typeUnspecified');
  return t(`admin.patients.detail.addressDrawer.type_${parsed}`, parsed);
}

export function LocalizacoesCard({ addresses, patientId, onSaved, focusRequest }: LocalizacoesCardProps) {
  const { t } = useTranslation();
  // D286: o lápis de cada endereço, e a ação "Marcar como principal", somem para quem não tem a
  // escrita do container (PATCH .../addresses/:id) — mesma célula, mesmo botão de escrita.
  const addressWriteGate = useActionGate('patient_address', 'write');
  const list = addresses ?? [];
  // Principal primeiro, depois a ordem recebida (sort é estável — ordem relativa preservada).
  // `isPrimary` vem de `is_default` (PatientDetailQueryHelper.ts) — spec 019 já não deriva de `address_type`.
  const rows = [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  // Spec 019: aviso quando há endereço ativo mas NENHUM marcado principal — hoje só acontece pela
  // rota "arquivar endereço pela ficha" (pendência separada, OP-04), mas a condição em si (nenhuma
  // linha com isPrimary) é verificável aqui sem esperar aquela rota.
  const hasAnyAddress = list.length > 0;
  const hasNoPrincipal = hasAnyAddress && !list.some((a) => a.isPrimary);
  // null = fechado · undefined = criar · objeto = editar a logística daquele endereço
  const [drawer, setDrawer] = useState<PatientAddressDetail | undefined | null>(null);
  useAutoOpenDrawer(focusRequest, 'ADDRESS', () => setDrawer(undefined));
  // Ação inline "Marcar como principal" (spec 019, US 4.2) — troca atômica no servidor
  // (AdminPatientAddressesController), sem precisar abrir o drawer de edição.
  const [markingId, setMarkingId] = useState<string | null>(null);
  /**
   * F1 (gate revisao-pr) — este `try/finally` NÃO tinha `catch`: um 409 de concorrência (outra
   * pessoa marcou principal ao mesmo tempo — ver "Concorrência" na spec 019) ou um 500 virava
   * promise rejeitada sem NENHUM aviso à operadora — o spinner do botão só parava, igual ao
   * defeito já corrigido em `PatientIdentityCard.tsx` (F4) e `ContractedServiceFormRow.tsx` (F4).
   * Mesmo canal de erro que esses cards já usam: `Text` vermelho com `role="alert"`, sem modal.
   */
  const [markError, setMarkError] = useState<string | null>(null);
  // `patientId` sempre presente aqui: o botão que chama isto só renderiza dentro de
  // `{patientId && ...}` (ver a célula do Tipo, abaixo). Reentrância dupla é bloqueada pelo
  // `disabled` do próprio botão (abaixo) enquanto `markingId` aponta pra este endereço — checar
  // de novo aqui seria branch morto, nunca exercitável por clique de verdade (jsdom não dispara
  // click em elemento `disabled`, igual ao navegador real).
  const onMarkPrimary = async (addressId: string): Promise<void> => {
    setMarkingId(addressId);
    setMarkError(null);
    try {
      await AdminApiService.updatePatientAddressLogistics(patientId as string, addressId, { is_default: true });
      onSaved?.();
    } catch (err) {
      // 409 (índice único vencido por outra requisição concorrente, ver spec 019 §Concorrência)
      // é o caso PREVISTO — a spec não define o texto, então a mensagem é curta e diz o que
      // aconteceu e o que fazer. Qualquer outro erro (500, rede) usa a mensagem genérica.
      if (err instanceof PatientApiError && err.status === 409) {
        setMarkError(t('admin.patients.detail.locationsCard.markPrimaryConflict'));
        // A lista pode ter mudado (outra pessoa já é o principal agora) — recarrega, já que
        // o card TEM função de recarga (`onSaved`, o mesmo refetch usado no caminho de sucesso).
        onSaved?.();
      } else {
        setMarkError(t('admin.patients.detail.locationsCard.markPrimaryError'));
      }
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="localizacoes-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.locationsCard.title')}
        </Heading>
        {/* D286 — POST /patients/:id/addresses → patient_address:write. */}
        <ActionButton resource="patient_address" action="write" variant="outline" size="sm" disabled={!patientId} onClick={() => setDrawer(undefined)} className="flex items-center gap-1" data-testid="new-address-btn">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </ActionButton>
      </div>

      {hasNoPrincipal && (
        <AvisoAmbar testId="address-no-principal-warning">
          {t('admin.patients.detail.locationsCard.noPrincipalWarning')}
        </AvisoAmbar>
      )}

      {markError && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="address-mark-primary-error">
          {markError}
        </Text>
      )}

      {drawer !== null && patientId && (
        // `key` muda entre criar (`'novo'`) e editar (`drawer.id`): força REMONTAGEM ao
        // trocar de modo sem fechar o drawer. Sem isto os dois ocupam o MESMO slot de JSX e
        // os `useState(address?.campo ?? '')` de logística (que só rodam na 1ª montagem)
        // ficam com o valor do modo anterior — PATCH apagando zona/corredor/acesso ao editar
        // depois de ter aberto "criar", ou POST levando o acesso do endereço que estava em
        // edição para um endereço novo. Medido pelo QA em jsdom; conserto #3.
        <PatientAddressDrawer
          key={drawer?.id ?? 'novo'}
          patientId={patientId}
          address={drawer}
          onClose={() => setDrawer(null)}
          onSaved={() => onSaved?.()}
        />
      )}

      {/* lex C2.1: rua + número é texto — sobe em claro para o Clarity sem isto. */}
      <div data-clarity-mask="True">
      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.locationsCard.tableType')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableAddress')}</TableHead>
          {patientId && <TableHead unwrapped><span className="sr-only">{t('admin.patients.detail.edit')}</span></TableHead>}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={patientId ? 3 : 2} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((addr) => {
              const { line1, line2 } = splitAddressForDisplay(addr);
              return (
                <TableRow key={addr.id} className="align-top">
                  <TableCell unwrapped>
                    <div className="flex flex-col items-start gap-1 px-3 py-2">
                      {/* Spec 019: `isPrimary` (de `is_default`) e o TIPO (`addressType`, lista
                          fechada por parentesco ou `null`) são campos INDEPENDENTES desde esta
                          entrega — mostram-se os dois juntos, nunca mais um substituindo o outro
                          (era OU/OU quando `isPrimary` ainda vinha de `address_type === 'primary'`,
                          fix do jurídico logo após a Fase 1). */}
                      <div className="flex items-center gap-2">
                        {addr.isPrimary && (
                          <span
                            className="shrink-0 bg-primary/10 text-primary px-1.5 py-0.5 rounded-full"
                            data-testid={`address-primary-badge-${addr.id}`}
                          >
                            <Text as="span" size="2xs" weight="medium" color="inherit">
                              {t('admin.patients.detail.locationsCard.primaryBadge')}
                            </Text>
                          </span>
                        )}
                        <Text as="span" size="sm" color="inherit">
                          {typeLabel(t, addr.addressType)}
                        </Text>
                      </div>
                      {/* D286: mesma célula do lápis — quem não tem patient_address:write não vê a ação. */}
                      {patientId && !addr.isPrimary && addressWriteGate.allowed && (
                        <button
                          type="button"
                          onClick={() => onMarkPrimary(addr.id)}
                          disabled={markingId === addr.id}
                          className="text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                          data-testid={`address-mark-primary-${addr.id}`}
                        >
                          <Text as="span" size="2xs" weight="medium" color="inherit">
                            {t('admin.patients.detail.locationsCard.markPrimary')}
                          </Text>
                        </button>
                      )}
                    </div>
                  </TableCell>
                  <TableCell unwrapped>
                    {line1 ? (
                      <div className="flex flex-col px-3 py-2">
                        <Text as="span" size="sm" color="inherit">{line1}</Text>
                        {line2 && <Text as="span" size="xs" color="secondary">{line2}</Text>}
                      </div>
                    ) : (
                      <div className="px-3 py-2">
                        <AvisoAmbar testId={`address-missing-${addr.id}`}>
                          {t('admin.patients.detail.locationsCard.noAddress')}
                        </AvisoAmbar>
                      </div>
                    )}
                  </TableCell>
                  {patientId && (
                    <TableCell unwrapped>
                      {/* D286: PATCH /patients/:id/addresses/:addressId → patient_address:write. */}
                      {addressWriteGate.allowed && (
                        <button type="button" onClick={() => setDrawer(addr)} aria-label={t('admin.patients.detail.locationsCard.editAddress')} className="text-slate-400 hover:text-primary transition-colors p-1 rounded" data-testid={`edit-address-${addr.id}`}>
                          <Pencil className="w-4 h-4" />
                        </button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
