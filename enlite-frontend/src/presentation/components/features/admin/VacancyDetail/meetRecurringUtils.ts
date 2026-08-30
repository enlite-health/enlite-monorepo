/** 'HH:MM:SS' do Postgres → 'HH:MM' do <input type="time">. Vazio quando não há hora ou o formato é estranho. */
export function toInputTime(time: string | null | undefined): string {
  if (!time) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
