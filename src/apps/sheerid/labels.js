// Match rendered country/month labels without changing the user's page language.
export async function formLocales(page, fallback) {
  const languages = await page.evaluate(() => [document.documentElement.lang, ...navigator.languages]);
  const locales = [];
  // The form can display Chinese while the browser still advertises English.
  for (const language of [...languages, fallback, 'en', 'zh-Hans', 'zh-Hant']) {
    if (!language) continue;
    try {
      const [locale] = Intl.getCanonicalLocales(language.replaceAll('_', '-'));
      if (!locales.includes(locale)) locales.push(locale);
    } catch { /* Ignore malformed language hints from the document. */ }
  }
  return locales;
}

export function countryChoice(country, locales) {
  const input = country.trim();
  const names = locales.map(locale => new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' }));
  let code = /^[a-z]{2}$/i.test(input) ? input.toUpperCase() : undefined;
  if (!code) {
    // Resolve names such as United States to an ISO code, then produce UI labels.
    // Unrecognized custom names remain exact matches; never guess a nearby country.
    const matches = [];
    for (let first = 65; first <= 90; first++) {
      for (let second = 65; second <= 90; second++) {
        const region = String.fromCharCode(first, second);
        if (names.some(display => display.of(region)?.toLocaleLowerCase() === input.toLocaleLowerCase())) matches.push(region);
      }
    }
    if (matches.length === 1) [code] = matches;
  }
  const labels = [...new Set([input, ...(code ? names.map(display => display.of(code)) : [])].filter(Boolean))];
  // Country choices are a finite list: clear the filter instead of searching an
  // English name against translated options. Wait for a real matching option.
  return { value: code ?? input, label: labels[0], labels, searchText: '' };
}

export function monthChoice(month, locales) {
  const date = new Date(Date.UTC(2000, Number(month) - 1, 1));
  const labels = locales.map(locale => new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date));
  // Some Chinese translations spell out the number instead of Intl's numeric form.
  const chinese = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  labels.push(`${chinese[Number(month) - 1]}月`);
  return { value: month, label: labels[0], labels: [...new Set(labels)] };
}
