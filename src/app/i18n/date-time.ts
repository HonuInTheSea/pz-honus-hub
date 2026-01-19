export function formatLocalizedDateTime(
  date: Date,
  locale: string | null | undefined,
): string {
  const resolvedLocale = locale || undefined;
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  const hour12 = resolveHour12Preference(resolvedLocale);
  if (hour12 === false) {
    options.hour12 = false;
  }
  return date.toLocaleString(resolvedLocale, options);
}

function resolveHour12Preference(
  locale: string | undefined,
): boolean | undefined {
  if (!locale) {
    return undefined;
  }
  const resolved = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
  return resolved.hour12;
}
