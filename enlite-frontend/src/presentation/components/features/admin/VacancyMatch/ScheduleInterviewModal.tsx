import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Calendar, X, Clock, Check, AlertCircle } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { TimeSelect } from '@presentation/components/atoms/TimeSelect';
import { useInterviewSlots } from '@hooks/admin/useInterviewSlots';
import type { SavedCandidate } from '../../../../../types/match';
import type { InterviewSlot } from '@domain/entities/InterviewSlot';

interface ScheduleInterviewModalProps {
  vacancyId: string;
  candidates: SavedCandidate[];
  onClose: () => void;
  onScheduled: () => void;
}

type CandidateStatus = 'pending' | 'loading' | 'success' | 'error';

interface CandidateBookingState {
  workerId: string;
  selectedSlotId: string;
  status: CandidateStatus;
  errorMessage?: string;
}

function generateSlotTimes(
  startTime: string,
  durationMin: number,
  count: number,
): Array<{ startTime: string; endTime: string }> {
  const result: Array<{ startTime: string; endTime: string }> = [];
  const [startHour, startMinute] = startTime.split(':').map(Number);
  let totalMinutes = startHour * 60 + startMinute;

  for (let i = 0; i < count; i++) {
    const s = totalMinutes;
    const e = totalMinutes + durationMin;
    const toTime = (m: number) =>
      `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    result.push({ startTime: toTime(s), endTime: toTime(e) });
    totalMinutes = e;
  }

  return result;
}

function slotLabel(slot: InterviewSlot, t: TFunction): string {
  const avail = slot.maxCapacity - slot.bookedCount;
  return t('admin.interviews.slotAvailability', {
    count: avail,
    start: slot.slotTime,
    end: slot.slotEndTime,
  });
}

interface Phase1Props {
  onCreated: () => void;
  createSlots: ReturnType<typeof useInterviewSlots>['createSlots'];
}

function SlotCreationForm({ onCreated, createSlots }: Phase1Props) {
  const { t } = useTranslation();
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [duration, setDuration] = useState(30);
  const [count, setCount] = useState(1);
  const [meetLink, setMeetLink] = useState('');
  const [capacity, setCapacity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!date || !startTime) {
      setFormError(t('admin.interviews.formErrorRequired'));
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    try {
      const times = generateSlotTimes(startTime, duration, count);
      await createSlots({
        meetLink: meetLink || undefined,
        slots: times.map(t => ({
          date,
          startTime: t.startTime,
          endTime: t.endTime,
          maxCapacity: capacity,
        })),
      });
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('admin.interviews.createSlotsError'));
    } finally {
      setIsSubmitting(false);
    }
  }, [date, startTime, duration, count, meetLink, capacity, createSlots, onCreated, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.dateLabel')}</label>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.startTimeLabel')}</label>
          <TimeSelect
            value={startTime}
            onChange={e => setStartTime(e.target.value)}
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.durationLabel')}</label>
          <select
            value={duration}
            onChange={e => setDuration(Number(e.target.value))}
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value={15}>{t('admin.interviews.durationMinutes', { count: 15 })}</option>
            <option value={30}>{t('admin.interviews.durationMinutes', { count: 30 })}</option>
            <option value={45}>{t('admin.interviews.durationMinutes', { count: 45 })}</option>
            <option value={60}>{t('admin.interviews.durationMinutes', { count: 60 })}</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.slotsCountLabel')}</label>
          <input
            type="number"
            min={1}
            max={20}
            value={count}
            onChange={e => setCount(Math.max(1, Math.min(20, Number(e.target.value))))}
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.capacityLabel')}</label>
          <input
            type="number"
            min={1}
            max={10}
            value={capacity}
            onChange={e => setCapacity(Math.max(1, Math.min(10, Number(e.target.value))))}
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">{t('admin.interviews.meetLinkLabel')}</label>
          <input
            type="url"
            value={meetLink}
            onChange={e => setMeetLink(e.target.value)}
            placeholder="https://meet.google.com/xxx-yyy-zzz"
            className="border border-[#D9D9D9] rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      {formError && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {formError}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          isLoading={isSubmitting}
          className="flex items-center gap-2"
        >
          <Clock className="w-4 h-4" />
          {t('admin.interviews.createSlots')}
        </Button>
      </div>
    </div>
  );
}

interface Phase2Props {
  candidates: SavedCandidate[];
  availableSlots: InterviewSlot[];
  bookSlot: ReturnType<typeof useInterviewSlots>['bookSlot'];
  onDone: () => void;
}

function CandidateBookingList({ candidates, availableSlots, bookSlot, onDone }: Phase2Props) {
  const { t } = useTranslation();
  const [bookingStates, setBookingStates] = useState<Record<string, CandidateBookingState>>(
    () => Object.fromEntries(
      candidates.map(c => [
        c.workerId,
        { workerId: c.workerId, selectedSlotId: availableSlots[0]?.id ?? '', status: 'pending' },
      ]),
    ),
  );

  const setSlot = (workerId: string, slotId: string) => {
    setBookingStates(prev => ({
      ...prev,
      [workerId]: { ...prev[workerId], selectedSlotId: slotId },
    }));
  };

  const handleBook = useCallback(async (candidate: SavedCandidate) => {
    const bs = bookingStates[candidate.workerId];
    if (!bs?.selectedSlotId) return;

    setBookingStates(prev => ({
      ...prev,
      [candidate.workerId]: { ...prev[candidate.workerId], status: 'loading' },
    }));

    try {
      await bookSlot(bs.selectedSlotId, candidate.workerId);
      setBookingStates(prev => ({
        ...prev,
        [candidate.workerId]: { ...prev[candidate.workerId], status: 'success' },
      }));
    } catch (err) {
      setBookingStates(prev => ({
        ...prev,
        [candidate.workerId]: {
          ...prev[candidate.workerId],
          status: 'error',
          errorMessage: err instanceof Error ? err.message : t('admin.interviews.scheduleError'),
        },
      }));
    }
  }, [bookingStates, bookSlot, t]);

  const allDone = candidates.every(
    c => bookingStates[c.workerId]?.status === 'success',
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 max-h-72 overflow-y-auto pr-1">
        {candidates.map(candidate => {
          const bs = bookingStates[candidate.workerId];
          const isSuccess = bs?.status === 'success';
          const isLoading = bs?.status === 'loading';
          const isError = bs?.status === 'error';

          return (
            <div
              key={candidate.workerId}
              className={`flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-xl border ${
                isSuccess ? 'border-green-200 bg-green-50' :
                isError ? 'border-red-200 bg-red-50' :
                'border-[#ECEFF1] bg-white'
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{candidate.workerName}</p>
                <p className="text-xs text-[#737373]">{candidate.workerPhone}</p>
                {isError && (
                  <p className="text-xs text-red-600 mt-0.5">{bs.errorMessage}</p>
                )}
              </div>

              {isSuccess ? (
                <div className="flex items-center gap-1 text-green-600 text-sm shrink-0">
                  <Check className="w-4 h-4" />
                  {t('admin.interviews.scheduled')}
                </div>
              ) : (
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={bs?.selectedSlotId ?? ''}
                    onChange={e => setSlot(candidate.workerId, e.target.value)}
                    disabled={isLoading}
                    className="border border-[#D9D9D9] rounded-lg px-2 py-1.5 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                  >
                    {availableSlots.length === 0 && (
                      <option value="">{t('admin.interviews.noAvailableSlots')}</option>
                    )}
                    {availableSlots.map(slot => (
                      <option key={slot.id} value={slot.id}>
                        {slotLabel(slot, t)}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleBook(candidate)}
                    isLoading={isLoading}
                    disabled={!bs?.selectedSlotId || availableSlots.length === 0}
                    className="text-xs px-3 py-1.5 h-auto"
                  >
                    {t('admin.interviews.schedule')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end pt-2 border-t border-[#ECEFF1]">
        <Button variant={allDone ? 'primary' : 'outline'} size="sm" onClick={onDone}>
          {t('admin.interviews.done')}
        </Button>
      </div>
    </div>
  );
}

export function ScheduleInterviewModal({
  vacancyId,
  candidates,
  onClose,
  onScheduled,
}: ScheduleInterviewModalProps) {
  const { t } = useTranslation();
  const { slots, createSlots, bookSlot } = useInterviewSlots(vacancyId);
  const [phase, setPhase] = useState<1 | 2>(1);

  const availableSlots = slots.filter(s => s.status === 'AVAILABLE');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            <Typography variant="h3" weight="semibold" className="text-[#737373] font-poppins">
              {phase === 1 ? t('admin.interviews.phaseTitle1') : t('admin.interviews.phaseTitle2')}
            </Typography>
          </div>
          <button
            onClick={onClose}
            className="text-[#737373] hover:text-red-500 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-2 text-xs text-[#737373]">
          <span className={phase === 1 ? 'font-semibold text-primary' : ''}>{t('admin.interviews.phaseStep1')}</span>
          <span>→</span>
          <span className={phase === 2 ? 'font-semibold text-primary' : ''}>{t('admin.interviews.phaseStep2')}</span>
        </div>

        {phase === 1 ? (
          <SlotCreationForm
            createSlots={createSlots}
            onCreated={() => setPhase(2)}
          />
        ) : (
          <CandidateBookingList
            candidates={candidates}
            availableSlots={availableSlots}
            bookSlot={bookSlot}
            onDone={onScheduled}
          />
        )}
      </div>
    </div>
  );
}
