import { fetchJson } from './provider';

/* Open-Meteo — free, NO KEY. URLSearchParams = params can never get truncated/mangled. */

export interface WeatherData {
  tempC: number; windKph: number; code: number;
  daily: { date: string; tmax: number; tmin: number; precip: number }[];
  fetchedAt: number;
}

export async function plainsWeather(): Promise<WeatherData> {
  const p = new URLSearchParams({
    latitude: '33.58',
    longitude: '-101.86',
    current: 'temperature_2m,wind_speed_10m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
    timezone: 'America/Chicago',
    forecast_days: '7',
  });
  const j: any = await fetchJson('https://api.open-meteo.com/v1/forecast?' + p.toString(), {}, 8000);
  const cur = j?.current ?? {};
  const d = j?.daily ?? {};
  const daily = (d.time ?? []).map((date: string, i: number) => ({
    date, tmax: d.temperature_2m_max?.[i] ?? 0, tmin: d.temperature_2m_min?.[i] ?? 0, precip: d.precipitation_sum?.[i] ?? 0,
  }));
  if (!daily.length) throw new Error('open-meteo: no data');
  return { tempC: cur.temperature_2m ?? 0, windKph: cur.wind_speed_10m ?? 0, code: cur.weather_code ?? 0, daily, fetchedAt: Date.now() };
}
