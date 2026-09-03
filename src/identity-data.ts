import { allFakers, type Faker } from "@faker-js/faker";

interface CountryNameSource {
  code: string;
  name: string;
  fakers: Faker[];
}

const DEFAULT_COUNTRY_BY_LANGUAGE: Record<string, string> = {
  ar: "EG", az: "AZ", cy: "GB", da: "DK", de: "DE", dv: "MV", el: "GR",
  en: "US", es: "ES", fa: "IR", fi: "FI", fr: "FR", he: "IL", hr: "HR",
  hu: "HU", hy: "AM", it: "IT", ja: "JP", ko: "KR", ku: "IQ", lv: "LV",
  mk: "MK", ne: "NP", nl: "NL", pl: "PL", ro: "RO", ru: "RU", sk: "SK",
  sv: "SE", th: "TH", tr: "TR", uk: "UA", ur: "PK", vi: "VN",
};

function localeCountryCode(localeKey: string, faker: Faker): string | undefined {
  const metadata = faker.getMetadata();
  if (metadata.country) return metadata.country;
  const language = metadata.language ?? localeKey.split("_")[0]!;
  return DEFAULT_COUNTRY_BY_LANGUAGE[language];
}

function buildCountrySources(): CountryNameSource[] {
  const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
  const grouped = new Map<string, Faker[]>();
  for (const [localeKey, faker] of Object.entries(allFakers)) {
    if (localeKey === "base" || localeKey === "en_BORK" || localeKey === "eo") continue;
    const code = localeCountryCode(localeKey, faker);
    if (!code) continue;
    const existing = grouped.get(code) ?? [];
    existing.push(faker);
    grouped.set(code, existing);
  }
  return [...grouped.entries()]
    .map(([code, fakers]) => ({ code, name: displayNames.of(code) ?? code, fakers }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export const COUNTRY_NAME_SOURCES = buildCountrySources();

export function randomCountryAndName(random: () => number = Math.random, offset = 0): {
  countryCode: string;
  country: string;
  name: string;
} {
  const sourceIndex = (Math.floor(random() * COUNTRY_NAME_SOURCES.length) + offset) % COUNTRY_NAME_SOURCES.length;
  const source = COUNTRY_NAME_SOURCES[sourceIndex]!;
  const faker = source.fakers[Math.floor(random() * source.fakers.length)]!;
  return {
    countryCode: source.code,
    country: source.name,
    name: faker.person.firstName(),
  };
}
