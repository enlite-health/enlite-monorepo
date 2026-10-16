/**
 * VacancySourceChangeNoticeBanner (vaga-le-do-servico-contratado, F4)
 *
 * Faixa no topo do detalhe da vaga publicada: o serviço contratado do paciente mudou (horário, quantidade de
 * profissionais ou faixa etária) e a vaga lê o valor novo — mas a publicação no Talentum e os candidatos já
 * convidados NÃO se atualizam sozinhos. O sistema só avisa; o recrutamento decide o que fazer e então marca
 * "atendido" (POST da F3), o que fecha o aviso daquele campo. Uma linha por campo aberto; o aviso nunca traz
 * valor antigo/novo (o backend não os guarda), só o campo e o instante.
 *
 * Aceita os 3 campos desde já (as fases de quantidade e faixa etária só ligam o backend).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { formatInstant } from '@presentation/utils/dateTimeFormat';
import type { SourceChangeField, VacancySourceChangeNotice } from '@domain/entities/Vacancy';

interface Props {
  vacancyId: string;
  notices: readonly VacancySourceChangeNotice[] | null | undefined;
  /** Chamado depois de fechar um aviso (a página recarrega o GET). */
  onAcknowledged?: () => void;
}

export function VacancySourceChangeNoticeBanner({ vacancyId, notices, onAcknowledged }: Props) {
  const { t } = useTranslation();
  const [closed, setClosed] = useState<ReadonlySet<SourceChangeField>>(new Set());
  const [busy, setBusy] = useState<SourceChangeField | null>(null);
  const [failed, setFailed] = useState<SourceChangeField | null>(null);

  const open = (notices ?? []).filter((n) => !closed.has(n.field));
  if (open.length === 0) return null;

  const acknowledge = async (field: SourceChangeField): Promise<void> => {
    setBusy(field);
    setFailed(null);
    try {
      await AdminApiService.acknowledgeVacancySourceChangeNotice(vacancyId, field);
      setClosed((prev) => new Set(prev).add(field));
      onAcknowledged?.();
    } catch {
      setFailed(field);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="mb-6 bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 flex flex-col gap-3"
      data-testid="source-change-notice-banner"
      role="status"
    >
      <div className="flex items-center gap-2 text-amber-900">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
        <Text as="span" size="sm" weight="semibold" color="inherit">
          {t('admin.vacancyDetail.sourceChangeNotice.title')}
        </Text>
      </div>
      {open.map((notice) => {
        const when = formatInstant(notice.changed_at, { dateStyle: 'short', timeStyle: 'short' });
        return (
          <div
            key={notice.field}
            className="flex items-start justify-between gap-4"
            data-testid={`source-change-notice-${notice.field}`}
          >
            <div className="flex flex-col gap-1">
              <Text size="sm" color="inherit" className="text-amber-900">
                {t(
                  `admin.vacancyDetail.sourceChangeNotice.message.${notice.field}`,
                  t('admin.vacancyDetail.sourceChangeNotice.message.generic'),
                )}
              </Text>
              {when && (
                <Text size="xs" color="inherit" className="text-amber-800">
                  {t('admin.vacancyDetail.sourceChangeNotice.changedAt', { date: when })}
                </Text>
              )}
              {failed === notice.field && (
                <Text size="xs" color="inherit" className="text-red-700" data-testid={`source-change-notice-error-${notice.field}`}>
                  {t('admin.vacancyDetail.sourceChangeNotice.error')}
                </Text>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy === notice.field}
              onClick={() => void acknowledge(notice.field)}
              data-testid={`source-change-notice-ack-${notice.field}`}
            >
              {t('admin.vacancyDetail.sourceChangeNotice.acknowledge')}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
