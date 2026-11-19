/**
 * PatientDailyReportsTab — aba "Informes diarios" da ficha do paciente (spec 092, T501, CA-10).
 *
 * Lista: data da guarda, prestador, nº de respostas, sinal (aviso imediato da planilha, DC-5) e atraso (derivado no servidor, DC-2).
 * Detalhe (clique em "Ver"): cada resposta com o item (objetivo/atividade), a escala, a opção marcada (ou a contagem), o motivo e a
 * nota quando a planilha a define; e o relatório descritivo.
 *
 * 🔒 O TEXTO é dado clínico: só chega do servidor com `daily_report_narrative:read` (sem a célula a API manda `narrative: null` +
 * `narrativeRedacted: true`, e nem lê o texto do banco). A tela NÃO decide isso — obedece ao servidor: `narrativeRedacted` mostra o
 * aviso de redação, `narrative` presente mostra o texto (mascarado no session replay, `data-clarity-mask`).
 *
 * Prestador: a rota devolve o id, não o nome (nome exigiria `worker_contact:read`, fora do desenho da T204). Usa o rótulo-padrão
 * `workerLabel` (8 últimos caracteres do id) — nenhum acesso novo.
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { usePatientDailyReports } from '@hooks/admin/usePatientDailyReports';
import type { PatientDailyReport, PatientDailyReportAnswer } from '@domain/entities/PatientDailyReport';
import { formatCalendarDate, formatInstant } from '@presentation/utils/dateTimeFormat';
import { workerLabel } from './workerLabel';

interface Props {
  patientId: string;
}

const dayOf = (iso: string): string => formatCalendarDate(iso, { dateStyle: 'short' }) ?? iso;
const instantOf = (iso: string): string => formatInstant(iso, { dateStyle: 'short', timeStyle: 'short' }) ?? iso;

function AnswerValue({ answer }: { answer: PatientDailyReportAnswer }): JSX.Element {
  return <>{answer.optionCode ?? String(answer.countValue)}</>;
}

export function PatientDailyReportsTab({ patientId }: Props): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string, opts?: Record<string, unknown>): string => t(`admin.patients.detail.dailyReportsTab.${key}`, opts);
  const { reports, status } = usePatientDailyReports(patientId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected: PatientDailyReport | null = reports.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4" data-testid="informes-diarios-aba">
      <Heading level={2} weight="semibold" color="secondary">{td('title')}</Heading>

      {status === 'loading' && (
        <div className="flex items-center gap-2 text-slate-600 text-sm" data-testid="informes-diarios-loading">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {td('loading')}
        </div>
      )}
      {status === 'forbidden' && (
        <Text as="p" size="sm" role="alert" className="text-red-800" data-testid="informes-diarios-forbidden">{td('forbidden')}</Text>
      )}
      {status === 'error' && (
        <Text as="p" size="sm" role="alert" className="text-red-800" data-testid="informes-diarios-error">{td('loadError')}</Text>
      )}
      {status === 'ok' && reports.length === 0 && (
        <Text as="p" size="sm" color="secondary" data-testid="informes-diarios-vazio">{td('empty')}</Text>
      )}

      {status === 'ok' && reports.length > 0 && (
        <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-4 sm:p-6" data-testid="informes-diarios-lista">
          <Table>
            <TableHeader>
              <TableHead>{td('colDate')}</TableHead>
              <TableHead>{td('colWorker')}</TableHead>
              <TableHead>{td('colAnswers')}</TableHead>
              <TableHead>{td('colSignal')}</TableHead>
              <TableHead>{td('colSubmitted')}</TableHead>
              <TableHead>{td('colActions')}</TableHead>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id} selected={r.id === selectedId} data-testid={`informe-diario-linha-${r.id}`}>
                  <TableCell weight="medium">{dayOf(r.onDate)}</TableCell>
                  <TableCell>{workerLabel(t, r.workerId, null)}</TableCell>
                  <TableCell data-testid={`informe-diario-respuestas-${r.id}`}>{r.answersCount}</TableCell>
                  <TableCell data-testid={`informe-diario-senal-${r.id}`}>
                    {r.immediateAlert ? <span className="font-semibold text-red-800">{td('signalImmediate')}</span> : '—'}
                  </TableCell>
                  <TableCell>
                    {instantOf(r.receivedAt)}
                    {r.late && <span className="ml-2 text-amber-800" data-testid={`informe-diario-atraso-${r.id}`}>{td('late')}</span>}
                  </TableCell>
                  <TableCell>
                    <Button variant="quiet" size="xs" onClick={() => setSelectedId(r.id)} data-testid={`informe-diario-ver-${r.id}`}>
                      {td('view')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {selected && (
        <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 flex flex-col gap-4" data-testid="informe-diario-detalle">
          <Heading level={3} weight="semibold" color="primary">
            {td('detailTitle', { date: dayOf(selected.onDate), worker: workerLabel(t, selected.workerId, null) })}
          </Heading>

          {selected.immediateAlert && (
            <Text as="p" size="sm" weight="semibold" className="text-red-800" data-testid="informe-diario-aviso-inmediato">
              {td('immediateNotice')}
            </Text>
          )}

          {selected.answers.length === 0 ? (
            <Text as="p" size="sm" color="secondary" data-testid="informe-diario-sin-respuestas">{td('noAnswers')}</Text>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="informe-diario-respuestas">
              {selected.answers.map((a) => (
                <li
                  key={`${a.itemKind}-${a.itemId}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-600 last:border-0 pb-2"
                  data-testid={`informe-diario-respuesta-${a.itemId}`}
                >
                  <Text as="span" size="sm" weight="medium" className="min-w-0 flex-1">
                    <span className="mr-2 text-gray-800">{td(a.itemKind === 'objective' ? 'kindObjective' : 'kindActivity')}</span>
                    {a.itemTitle}
                  </Text>
                  <Text as="span" size="sm" color="secondary">{td('scale', { code: a.scaleCode })}</Text>
                  <Text as="span" size="sm" weight="semibold"><AnswerValue answer={a} /></Text>
                  {a.reasonCode && <Text as="span" size="sm" color="secondary">{td('reason', { code: a.reasonCode })}</Text>}
                  {a.score !== null && <Text as="span" size="sm" color="secondary">{td('score', { score: a.score })}</Text>}
                  {a.immediateAlert && <Text as="span" size="sm" weight="semibold" className="text-red-800">{td('signalImmediate')}</Text>}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1">
            <Text as="span" size="xs" weight="semibold" color="secondary">{td('narrativeLabel')}</Text>
            {selected.narrativeRedacted ? (
              <Text as="p" size="sm" color="secondary" data-testid="informe-diario-texto-oculto">{td('narrativeRedacted')}</Text>
            ) : (
              <div data-clarity-mask="True">
                <Text as="p" size="sm" className="whitespace-pre-wrap" data-testid="informe-diario-texto">{selected.narrative}</Text>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
