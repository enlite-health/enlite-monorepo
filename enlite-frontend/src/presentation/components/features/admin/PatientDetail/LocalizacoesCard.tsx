import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { streetLineOf, summarizeAddress } from '@presentation/utils/summarizeAddress';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';
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
 * O que a coluna Dirección mostra em 2 linhas:
 *  • linha 1 — rua + número, via `streetLineOf` (utils/summarizeAddress.ts) — a MESMA
 *    fronteira rua↔resto que `VacancyFormSection.tsx` já usa por `summarizeAddress`. Achado
 *    do gate `revisao-pr` (BLOCKER): esta função tinha uma cópia local dessa fronteira que
 *    divergia da de produção (cortava o número no formato BR real "975 - Consolação") — a
 *    cópia foi apagada, as duas leituras vêm do mesmo módulo agora.
 *  • linha 2 (texto secundário) — `neighborhood` quando existe; senão `summarizeAddress(full)`
 *    (o resumo em nível de localidade, país e CEP já removidos); `null` quando não sobra nada.
 * `null` nas duas quando o endereço não tem NEM formatado NEM cru (linha vira alerta) — ""
 * conta como ausente nos dois campos (`.trim()`), não só `null`/`undefined`.
 */
function splitAddressForDisplay(
  addr: Pick<PatientAddressDetail, 'addressFormatted' | 'addressRaw' | 'neighborhood'>,
): { line1: string | null; line2: string | null } {
  const formatted = (addr.addressFormatted ?? '').trim();
  const raw = (addr.addressRaw ?? '').trim();
  const full = formatted || raw || null;
  if (!full) return { line1: null, line2: null };

  const line1 = streetLineOf(full) || full;
  const line2 = addr.neighborhood ?? (summarizeAddress(full) || null);
  return { line1, line2 };
}

export function LocalizacoesCard({ addresses, patientId, onSaved, focusRequest }: LocalizacoesCardProps) {
  const { t } = useTranslation();
  // D286: o lápis de cada endereço some para quem não tem a escrita do container (PATCH .../addresses/:id).
  const addressWriteGate = useActionGate('patient_address', 'write');
  // Principal primeiro, depois a ordem recebida (sort é estável — ordem relativa preservada).
  const rows = [...(addresses ?? [])].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  // null = fechado · undefined = criar · objeto = editar a logística daquele endereço
  const [drawer, setDrawer] = useState<PatientAddressDetail | undefined | null>(null);
  useAutoOpenDrawer(focusRequest, 'ADDRESS', () => setDrawer(undefined));

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

      {drawer !== null && patientId && (
        <PatientAddressDrawer
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
                    <div className="flex items-center gap-2 px-3 py-2">
                      {/* Fix do jurídico (sessão seguinte à Fase 1): isPrimary é 100% derivado
                          de address_type === 'primary' (PatientDetailQueryHelper.ts:228) — mostrar
                          o rótulo do Tipo E o selo juntos repetia a mesma palavra "Principal".
                          Agora é OU/OU: selo quando isPrimary, rótulo do tipo quando não. */}
                      {addr.isPrimary ? (
                        <span
                          className="shrink-0 bg-primary/10 text-primary px-1.5 py-0.5 rounded-full"
                          data-testid={`address-primary-badge-${addr.id}`}
                        >
                          <Text as="span" size="2xs" weight="medium" color="inherit">
                            {t('admin.patients.detail.locationsCard.primaryBadge')}
                          </Text>
                        </span>
                      ) : (
                        <Text as="span" size="sm" color="inherit">
                          {t(`admin.patients.detail.addressDrawer.type_${addr.addressType}`, addr.addressType)}
                        </Text>
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
