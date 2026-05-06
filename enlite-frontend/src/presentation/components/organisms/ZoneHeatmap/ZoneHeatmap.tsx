import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { MapPin } from 'lucide-react';

interface ZoneData {
  zone: string;
  caseCount: number;
  activeCount: number;
  percentage: string;
}

interface ZoneHeatmapProps {
  zones: ZoneData[];
  totalCases: number;
  nullCount: number;
  identifiedZones: number;
}

export function ZoneHeatmap({
  zones,
  totalCases,
  nullCount,
  identifiedZones,
}: ZoneHeatmapProps): JSX.Element {
  const { t } = useTranslation();

  const maxCount = Math.max(...zones.map(z => z.caseCount));

  const getHeatColor = (count: number): string => {
    const intensity = count / maxCount;
    const hue = 220 - (intensity * 45);
    const saturation = 70 + (intensity * 30);
    const lightness = 85 - (intensity * 50);
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  };

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-xl p-6 text-white">
        <div className="flex items-center gap-3 mb-4">
          <div className="bg-cyan-500 px-3 py-1 rounded text-xs font-bold animate-pulse">
            INTEL
          </div>
          <Heading level={2} weight="bold" color="white">
            {t('admin.recruitment.zoneAnalysis')}
          </Heading>
        </div>
        <Text size="sm" color="inherit" className="text-gray-300">
          {t('admin.recruitment.zoneSource')}
        </Text>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-blue-50 p-4 rounded-lg">
          <Text size="sm" color="muted">
            {t('admin.recruitment.totalCases')}
          </Text>
          <Heading level={2} weight="bold" color="inherit" className="text-blue-600">
            {totalCases}
          </Heading>
        </div>
        <div className="bg-green-50 p-4 rounded-lg">
          <Text size="sm" color="muted">
            {t('admin.recruitment.identifiedZones')}
          </Text>
          <Heading level={2} weight="bold" color="inherit" className="text-green-600">
            {identifiedZones}
          </Heading>
        </div>
        <div className={`p-4 rounded-lg ${nullCount > 0 ? 'bg-amber-50' : 'bg-gray-50'}`}>
          <Text size="sm" color="muted">
            {t('admin.recruitment.noZone')}
          </Text>
          <Heading level={2} weight="bold" color="inherit" className={nullCount > 0 ? 'text-amber-600' : 'text-gray-600'}>
            {nullCount}
          </Heading>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {zones.filter(z => z.zone !== 'Sin Zona').map((zone, idx) => (
          <div
            key={idx}
            className="p-4 rounded-lg border-2 transition-all hover:shadow-lg"
            style={{ backgroundColor: getHeatColor(zone.caseCount) }}
          >
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <MapPin size={16} className="text-gray-700" />
                <Text size="sm" weight="bold" color="inherit" className="text-gray-900">
                  {zone.zone}
                </Text>
              </div>
              <Heading level={3} weight="bold" color="inherit" className="text-gray-900">
                {zone.caseCount}
              </Heading>
            </div>
            <Text size="sm" color="inherit" className="text-gray-700">
              {zone.percentage}% {t('admin.recruitment.ofTotal')}
            </Text>
            <div className="mt-2 h-2 bg-gray-900 bg-opacity-10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gray-900 bg-opacity-30"
                style={{ width: `${zone.percentage}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
