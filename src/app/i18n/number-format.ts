type CjkNumberConfig = Readonly<{
  digits: string[];
  units: string[];
  groupUnits: string[];
}>;

const CJK_CONFIGS: Record<string, CjkNumberConfig> = {
  'zh-hans': {
    digits: ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'],
    units: ['', '十', '百', '千'],
    groupUnits: ['', '万', '亿', '兆'],
  },
  'zh-hant': {
    digits: ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'],
    units: ['', '十', '百', '千'],
    groupUnits: ['', '萬', '億', '兆'],
  },
  ja: {
    digits: ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'],
    units: ['', '十', '百', '千'],
    groupUnits: ['', '万', '億', '兆'],
  },
  ko: {
    digits: ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'],
    units: ['', '십', '백', '천'],
    groupUnits: ['', '만', '억', '조'],
  },
};

export function formatTagCount(count: number, locale: string): string {
  const normalizedLocale = (locale || 'en-US').toLowerCase();
  const formatter = new Intl.NumberFormat(normalizedLocale);

  const config = getCjkConfig(normalizedLocale);
  if (config) {
    return formatCjkNumber(count, config);
  }

  return formatter.format(count);
}

function getCjkConfig(locale: string): CjkNumberConfig | null {
  if (locale.startsWith('zh')) {
    if (
      locale.includes('zh-hant') ||
      locale.includes('-tw') ||
      locale.includes('-hk') ||
      locale.includes('-mo')
    ) {
      return CJK_CONFIGS['zh-hant'];
    }
    return CJK_CONFIGS['zh-hans'];
  }
  if (locale.startsWith('ja')) {
    return CJK_CONFIGS['ja'];
  }
  if (locale.startsWith('ko')) {
    return CJK_CONFIGS['ko'];
  }
  return null;
}

function formatCjkNumber(value: number, config: CjkNumberConfig): string {
  const safeValue = Math.max(0, Math.floor(value));
  if (safeValue === 0) {
    return config.digits[0];
  }

  const groups: number[] = [];
  let remaining = safeValue;
  while (remaining > 0) {
    groups.unshift(remaining % 10000);
    remaining = Math.floor(remaining / 10000);
  }

  const parts: string[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (group === 0) {
      const hasNext = groups.slice(i + 1).some((next) => next > 0);
      if (hasNext && parts.length > 0 && !parts[parts.length - 1].endsWith(config.digits[0])) {
        parts.push(config.digits[0]);
      }
      continue;
    }

    const groupText = formatCjkGroup(group, config);
    const groupUnit = config.groupUnits[groups.length - 1 - i] ?? '';
    parts.push(`${groupText}${groupUnit}`);
  }

  return parts.join('');
}

function formatCjkGroup(group: number, config: CjkNumberConfig): string {
  let result = '';
  let zeroPending = false;

  for (let i = 3; i >= 0; i -= 1) {
    const divisor = 10 ** i;
    const digit = Math.floor(group / divisor) % 10;
    const remainder = group % divisor;

    if (digit === 0) {
      if (result && remainder > 0) {
        zeroPending = true;
      }
      continue;
    }

    if (zeroPending) {
      result += config.digits[0];
      zeroPending = false;
    }

    if (digit === 1 && i > 0) {
      result += config.units[i];
    } else {
      result += `${config.digits[digit]}${config.units[i]}`;
    }
  }

  return result;
}
