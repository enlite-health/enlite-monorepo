import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Clock } from 'lucide-react';

interface AvailabilitySlot {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  crossesMidnight: boolean;
}

interface WorkerAvailabilityCardProps {
  availability: AvailabilitySlot[];
}

const DAY_KEYS = [
  'workerRegistration.availability.sunday',
  'workerRegistration.availability.monday',
  'workerRegistration.availability.tuesday',
  'workerRegistration.availability.wednesday',
  'workerRegistration.availability.thursday',
  'workerRegistration.availability.friday',
  'workerRegistration.availability.saturday',
];

function formatTime(time: string): string {
  // time comes as "HH:MM:SS" from backend, show "HH:MM"
  return time.slice(0, 5);
}

export function WorkerAvailabilityCard({ availability }: WorkerAvailabilityCardProps) {
  const { t } = useTranslation();

  // Group slots by day
  const slotsByDay = new Map<number, AvailabilitySlot[]>();
  for (const slot of availability) {
    const existing = slotsByDay.get(slot.dayOfWeek) ?? [];
    existing.push(slot);
    slotsByDay.set(slot.dayOfWeek, existing);
  }

  if (availability.length === 0) {
    return (
      <div data-testid="worker-availability-card" className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
        <Heading level={1} as="h3" color="secondary">
          {t('admin.workerDetail.tabs.availability')}
        </Heading>
        <Text size="sm" color="muted">
          {t('admin.workerDetail.noAvailability')}
        </Text>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <Heading level={1} as="h3" color="secondary">
        {t('admin.workerDetail.tabs.availability')}
      </Heading>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4, 5, 6].map((day) => {
          const slots = slotsByDay.get(day);
          if (!slots) return null;
          return (
            <div key={day} className="flex justify-between items-start">
              <Text size="sm" weight="medium" className="min-w-[120px]">
                {t(DAY_KEYS[day])}
              </Text>
              <div className="flex flex-wrap justify-end gap-2">
                {slots.map((slot) => (
                  <span
                    key={slot.id}
                    className="flex items-center gap-1 px-3 py-1 rounded-full bg-primary/10 text-primary"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <Text as="span" size="sm" weight="medium" color="inherit">
                      {formatTime(slot.startTime)} – {formatTime(slot.endTime)}
                    </Text>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
