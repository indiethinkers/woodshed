import { ArrowDown, ArrowUp, CloudSun } from "lucide-react";

import { MessageResponse } from "@/components/ai-elements/message";

interface WeatherPreviewDay {
  condition: string;
  day: string;
  high: string | null;
  low: string | null;
  note: string | null;
}

export interface WeatherPreviewData {
  days: WeatherPreviewDay[];
  followUp: string;
  intro: string;
  source: string | null;
}

export function AgentWeatherResponse({
  preview,
  rawResponse,
}: {
  preview: WeatherPreviewData;
  rawResponse: string;
}) {
  return (
    <div className="space-y-4">
      {preview.intro && <MessageResponse>{preview.intro}</MessageResponse>}
      <section
        aria-label="Weather forecast"
        className="overflow-hidden rounded-xl border border-border/75 bg-gradient-to-b from-muted/35 to-muted/10 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.55)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-border/65 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background/70 shadow-sm">
              <CloudSun
                aria-hidden
                className="size-4 text-foreground/75"
                strokeWidth={1.8}
              />
            </span>
            <div>
              <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                Forecast
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {preview.days.length}-day outlook
              </p>
            </div>
          </div>
          {preview.source && (
            <span className="rounded-full border border-border/70 bg-background/55 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              {preview.source}
            </span>
          )}
        </header>
        <div className="grid grid-cols-2 divide-x divide-y divide-border/60 sm:grid-cols-3">
          {preview.days.map((day) => (
            <article
              className="min-w-0 px-4 py-3.5"
              key={`${day.day}-${day.high}-${day.low}`}
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {day.day}
              </div>
              <div className="mt-1.5 min-h-10 text-[13px] leading-5 text-foreground/85">
                {day.condition}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
                {day.high && (
                  <span
                    aria-label={`High ${day.high} degrees`}
                    className="inline-flex items-center gap-0.5 font-semibold text-foreground"
                  >
                    <ArrowUp aria-hidden className="size-3" strokeWidth={2} />
                    {day.high}°
                  </span>
                )}
                {day.low && (
                  <span
                    aria-label={`Low ${day.low} degrees`}
                    className="inline-flex items-center gap-0.5 text-muted-foreground"
                  >
                    <ArrowDown aria-hidden className="size-3" strokeWidth={2} />
                    {day.low}°
                  </span>
                )}
              </div>
              {day.note && (
                <div className="mt-2 text-[10px] font-medium text-muted-foreground/80">
                  {day.note}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {preview.followUp && (
        <MessageResponse>{preview.followUp}</MessageResponse>
      )}
      <details className="group rounded-lg border border-border/60 bg-muted/10 px-3 py-2">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          View original response
        </summary>
        <MessageResponse className="mt-3 border-t border-border/60 pt-3 text-sm">
          {rawResponse}
        </MessageResponse>
      </details>
    </div>
  );
}

const WEATHER_DAY_RE =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):\s*/gi;
const WEATHER_HIGH_RE =
  /\bhigh(?:\s+(?:near|around|of|about))?\s+(-?\d{1,3})(?:\s*°?\s*[FC])?/i;
const WEATHER_LOW_RE =
  /\blow(?:\s+(?:near|around|of|about))?\s+(-?\d{1,3})(?:\s*°?\s*[FC])?/i;

export function weatherPreviewFromResponse(
  text: string,
): WeatherPreviewData | null {
  if (!text.trim()) return null;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim());
  const forecastIndex = paragraphs.findIndex((paragraph) => {
    const dayCount = [...paragraph.matchAll(WEATHER_DAY_RE)].length;
    const temperatureCount = [
      ...paragraph.matchAll(/\b(?:high|low)\b/gi),
    ].length;
    return dayCount >= 2 && temperatureCount >= 2;
  });
  if (forecastIndex < 0) return null;

  const forecast = paragraphs[forecastIndex];
  const matches = [...forecast.matchAll(WEATHER_DAY_RE)];
  const days = matches.flatMap((match, index): WeatherPreviewDay[] => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? forecast.length;
    const body = forecast.slice(start, end).trim();
    const high = body.match(WEATHER_HIGH_RE)?.[1] ?? null;
    const low = body.match(WEATHER_LOW_RE)?.[1] ?? null;
    if (!high && !low) return [];
    const firstTemperature = [
      body.search(WEATHER_HIGH_RE),
      body.search(WEATHER_LOW_RE),
    ]
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    const rawCondition = body
      .slice(0, firstTemperature)
      .replace(/[,:;\s]+$/, "")
      .trim();
    const note = body.match(/\(([^)]+)\)/)?.[1]?.trim() || null;
    return [
      {
        condition: sentenceCase(rawCondition || "Forecast available"),
        day: sentenceCase(match[1]),
        high,
        low,
        note,
      },
    ];
  });
  if (days.length < 2) return null;

  const source = /National Weather Service/i.test(text)
    ? "National Weather Service"
    : /\bNWS\b/.test(text)
      ? "NWS"
      : null;
  return {
    intro: paragraphs.slice(0, forecastIndex).filter(Boolean).join("\n\n"),
    source,
    days,
    followUp: paragraphs
      .slice(forecastIndex + 1)
      .filter(Boolean)
      .join("\n\n"),
  };
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1)}`;
}
