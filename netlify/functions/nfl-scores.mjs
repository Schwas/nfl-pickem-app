// netlify/functions/nfl-scores.mjs
// No API key required; this public ESPN feed is unofficial and may change.
// The function keeps external API URLs and response shape out of the browser.
const SEASON = 2026;
const SOURCE = "ESPN public scoreboard feed (unofficial)";
const TEAM_IDS = {
  JAC: "JAX", JAX: "JAX", WSH: "WAS", WAS: "WAS", LA: "LAR",
  LAR: "LAR", OAK: "LV", LV: "LV", SD: "LAC", LAC: "LAC",
  STL: "LAR", ARZ: "ARI", AZ: "ARI", ARI: "ARI",
};

function normalizeId(value) {
  const abbreviation = String(value || "").toUpperCase();
  return TEAM_IDS[abbreviation] || abbreviation;
}

function requestedWeeks(url) {
  const params = new URL(url).searchParams;
  const through = Number(params.get("throughWeek"));
  if (params.has("throughWeek")) {
    if (!Number.isInteger(through) || through < 1 || through > 18) return null;
    return Array.from({ length: through }, (_, index) => index + 1);
  }
  const values = (params.get("weeks") || "1").split(",");
  const weeks = [...new Set(values.map((item) => Number(item)))];
  if (weeks.length > 18 || weeks.some((week) => !Number.isInteger(week) || week < 1 || week > 18)) return null;
  return weeks;
}

function numberOrNull(value) {
  const actual = value && typeof value === "object" ? value.value ?? value.displayValue : value;
  if (actual === null || actual === undefined || actual === "") return null;
  const number = Number(actual);
  return Number.isFinite(number) ? number : null;
}

function transformEvent(event, week) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const away = competitors.find((item) => item.homeAway === "away");
  const home = competitors.find((item) => item.homeAway === "home");
  if (!away?.team?.abbreviation || !home?.team?.abbreviation) return null;

  const rawState = event.status?.type?.state || competition?.status?.type?.state || "pre";
  const state = ["pre", "in", "post"].includes(rawState) ? rawState : "pre";
  const detail = event.status?.type?.shortDetail || event.status?.type?.detail || "";
  return {
    week,
    awayTeam: normalizeId(away.team.abbreviation),
    homeTeam: normalizeId(home.team.abbreviation),
    awayScore: numberOrNull(away.score),
    homeScore: numberOrNull(home.score),
    state,
    detail: String(detail).slice(0, 90),
    kickoff: event.date || competition.date || null,
  };
}

async function fetchWeek(week) {
  const url = new URL("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
  url.searchParams.set("season", String(SEASON));
  url.searchParams.set("seasontype", "2");
  url.searchParams.set("week", String(week));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Scoreboard HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.events)) throw new Error("Invalid ESPN scoreboard response");
  if (payload.season?.year && Number(payload.season.year) !== SEASON) throw new Error("Unexpected ESPN season");
  if (payload.week?.number && Number(payload.week.number) !== week) throw new Error("Unexpected ESPN week");
  const games = payload.events.map((event) => transformEvent(event, week)).filter(Boolean);
  // An empty week is treated as failed to avoid silently wiping scores from the UI.
  if (!games.length) throw new Error(`No games returned for Week ${week}`);
  return games;
}

export default async (request) => {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const weeks = requestedWeeks(request.url);
  if (!weeks) return Response.json({ error: "Invalid weeks (choose 1–18)" }, { status: 400 });

  const results = await Promise.allSettled(weeks.map(fetchWeek));
  const games = [];
  const weeksLoaded = [];
  const weeksFailed = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      games.push(...result.value);
      weeksLoaded.push(weeks[index]);
    } else {
      console.error(`NFL scores Week ${weeks[index]}:`, result.reason?.message);
      weeksFailed.push(weeks[index]);
    }
  });
  return Response.json(
    { source: SOURCE, updatedAt: new Date().toISOString(), weeksLoaded, weeksFailed, games },
    {
      status: weeksLoaded.length ? 200 : 502,
      headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=60" },
    }
  );
};
