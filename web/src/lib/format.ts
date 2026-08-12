export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatPercent(part: number, whole: number) {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

export function metricTone(value: number) {
  if (value >= 85) return "good";
  if (value >= 65) return "warn";
  return "bad";
}

export function fullDate(value: string) {
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}
