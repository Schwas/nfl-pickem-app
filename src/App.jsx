import { useEffect, useState } from "react";
import { teams } from "./data/teams";
import { schedule2026 } from "./data/schedule2026";
import "./App.css";

// Real game results always override simulated outcomes in season standings.
// ESPN's scoreboard is unofficial; the Netlify Function validates its response.
const SCORE_ENDPOINT = "/.netlify/functions/nfl-scores";
const SCORE_REFRESH_MS = 120000;
const SCORES_CACHE_KEY = "nfl-pickem-score-cache-2026";
const TIE_PICK = "TIE";

// These are illustrative simulator weights, not real betting odds or live ratings.
const SIM_STRENGTH = {
  ARI: 71, ATL: 79, BAL: 89, BUF: 92, CAR: 70, CHI: 80,
  CIN: 85, CLE: 69, DAL: 79, DEN: 85, DET: 89, GB: 85,
  HOU: 83, IND: 78, JAX: 77, KC: 90, LAC: 84, LAR: 87,
  LV: 70, MIA: 76, MIN: 82, NE: 77, NO: 70, NYG: 71,
  NYJ: 72, PHI: 90, PIT: 82, SEA: 85, SF: 84, TB: 81,
  TEN: 69, WAS: 81,
};

function easternDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const read = (kind) => parts.find((part) => part.type === kind)?.value;
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function currentScheduleWeek() {
  const today = easternDateKey();
  const startedWeeks = schedule2026
    .filter((game) => /^\d{4}-\d{2}-\d{2}$/.test(game.date) && game.date <= today)
    .map((game) => Number(game.week));
  return Math.max(1, ...startedWeeks);
}

function scoreboardKey(game) {
  return `${game.week}:${game.awayTeam}:${game.homeTeam}`;
}

function safeScoreCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(SCORES_CACHE_KEY) || "null");
    if (saved && typeof saved.games === "object" && saved.games) return saved;
  } catch {
    // Offline or invalid cache should never prevent the app from loading.
  }
  return { games: {}, updatedAt: null };
}

function recordText(data) {
  return `${data.wins}-${data.losses}-${data.ties}`;
}

function App() {
  const [selectedTeamId, setSelectedTeamId] = useState("DET");
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [myPicksWeekFilter, setMyPicksWeekFilter] = useState("all");

  const [scoreCache, setScoreCache] = useState(safeScoreCache);
  const [scoreError, setScoreError] = useState("");
  const [scoreLoading, setScoreLoading] = useState(false);
  const [scoreSourceReady, setScoreSourceReady] = useState(false);

  const [picks, setPicks] = useState(() => {
    const savedPicks = localStorage.getItem("nfl-pickem-picks");

    if (savedPicks) {
      return JSON.parse(savedPicks);
    }

    return {};
  });

  useEffect(() => {
    localStorage.setItem("nfl-pickem-picks", JSON.stringify(picks));
  }, [picks]);

  useEffect(() => {
    // One initial load fills previous weeks; periodic checks fetch only this/last week.
    let disposed = false;
    let liveGamesActive = false;
    let lastBackgroundCheck = Date.now();
    const controller = new AbortController();

    async function loadScores(fullSeasonHistory = false) {
      if (disposed || document.visibilityState === "hidden") return;
      const week = currentScheduleWeek();
      const parameters = fullSeasonHistory
        ? `throughWeek=${week}`
        : `weeks=${[Math.max(1, week - 1), week].join(",")}`;

      setScoreLoading(true);
      try {
        const response = await fetch(`${SCORE_ENDPOINT}?${parameters}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Score service returned ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.games) || !Array.isArray(payload.weeksLoaded)) {
          throw new Error("Unexpected scoreboard response");
        }
        if (disposed) return;

        setScoreCache((previous) => {
          const updated = { ...previous.games };
          const received = new Set(payload.weeksLoaded);
          for (const key of Object.keys(updated)) {
            if (received.has(Number(key.split(":")[0]))) delete updated[key];
          }
          for (const game of payload.games) {
            const validState = ["pre", "in", "post"].includes(game.state);
            if (!validState || !Number.isInteger(game.week) || !game.awayTeam || !game.homeTeam) continue;
            updated[scoreboardKey(game)] = game;
          }
          const next = { games: updated, updatedAt: new Date().toISOString() };
          try { localStorage.setItem(SCORES_CACHE_KEY, JSON.stringify(next)); } catch { /* optional */ }
          return next;
        });
        liveGamesActive = payload.games.some((game) => game.state === "in");
        setScoreSourceReady(true);
        setScoreError(payload.weeksFailed?.length
          ? `Could not load Week ${payload.weeksFailed.join(", ")} scores.`
          : "");
      } catch (error) {
        if (!disposed && error.name !== "AbortError") {
          setScoreError("Live scores are unavailable right now. Showing last cached results if present.");
        }
      } finally {
        if (!disposed) setScoreLoading(false);
      }
    }

    loadScores(true);
    const interval = window.setInterval(() => {
      // Save function calls when no game is live: 10 minutes otherwise 2 minutes.
      if (liveGamesActive || Date.now() - lastBackgroundCheck >= 600000) {
        lastBackgroundCheck = Date.now();
        loadScores(false);
      }
    }, SCORE_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible") loadScores(true); };
    document.addEventListener("visibilitychange", onVisible);
    // The button requests a refresh without reloading the page.
    const onRefresh = () => loadScores(true);
    window.addEventListener("nfl-refresh-scores", onRefresh);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("nfl-refresh-scores", onRefresh);
    };
  }, []);

  const selectedTeam = getTeamById(selectedTeamId);
  const selectedTeamProjectedRecord = getProjectedRecord(selectedTeamId);
  const selectedTeamPickProgress = getTeamPickProgress(selectedTeamId);

  const selectedTeamSchedule = schedule2026.filter(
    (game) =>
      game.homeTeam === selectedTeamId || game.awayTeam === selectedTeamId
  );

  const selectedWeekGames = schedule2026.filter(
    (game) => game.week === selectedWeek
  );

  const availableWeeks = [...new Set(schedule2026.map((game) => game.week))];

  const totalGames = schedule2026.length;
  const totalPickedGames = schedule2026.filter((game) => Boolean(picks[game.id])).length;
  const scoreCounts = { correct: 0, wrong: 0, push: 0, pending: 0 };
  schedule2026.forEach((game) => {
    if (!picks[game.id]) return;
    const outcome = getPickEvaluation(game);
    if (outcome in scoreCounts) scoreCounts[outcome] += 1;
  });

  const selectedWeekPickedGames = selectedWeekGames.filter(
    (game) => picks[game.id]
  ).length;

  const completedWeeks = availableWeeks.filter(
    (week) => getWeekPickProgress(week).isComplete
  ).length;

  const divisionStandings = getDivisionStandings();
  const afcStandings = getConferenceStandings("AFC");
  const nfcStandings = getConferenceStandings("NFC");
  const afcPlayoffPicture = getPlayoffPicture("AFC");
  const nfcPlayoffPicture = getPlayoffPicture("NFC");
  const overallStandings = getOverallStandings();

  function getTeamById(teamId) {
    return teams.find((team) => team.id === teamId);
  }

  function getLiveGame(game) {
    return scoreCache.games[scoreboardKey(game)];
  }

  function getActualWinner(game) {
    const score = getLiveGame(game);
    if (!score || score.state !== "post" ||
        !Number.isFinite(score.awayScore) || !Number.isFinite(score.homeScore)) return null;
    if (score.awayScore === score.homeScore) return TIE_PICK;
    return score.awayScore > score.homeScore ? game.awayTeam : game.homeTeam;
  }

  function getEffectiveWinner(game) {
    return getActualWinner(game) || picks[game.id] || null;
  }

  function getPickEvaluation(game) {
    const pick = picks[game.id];
    if (!pick) return null;
    const actual = getActualWinner(game);
    if (!actual) return "pending";
    if (actual === TIE_PICK && pick !== TIE_PICK) return "push";
    return pick === actual ? "correct" : "wrong";
  }

  function isGameStarted(game) {
    const score = getLiveGame(game);
    if (score) {
      if (score.state === "in" || score.state === "post") return true;
      if (score.kickoff && Number.isFinite(new Date(score.kickoff).getTime())) {
        return new Date(score.kickoff).getTime() <= Date.now();
      }
      return false;
    }
    // When the feed is down, don't simulate earlier calendar dates as future games.
    return /^\d{4}-\d{2}-\d{2}$/.test(game.date) && game.date < easternDateKey();
  }

  function simulateGame(game) {
    const away = SIM_STRENGTH[game.awayTeam] ?? 78;
    const home = SIM_STRENGTH[game.homeTeam] ?? 78;
    // Approximate 3-point home advantage, unless this is a neutral-site game.
    const difference = home + (game.neutralSite ? 0 : 3) - away;
    const homeChance = Math.min(0.83, Math.max(0.17, 0.5 + difference * 0.015));
    return Math.random() < homeChance ? game.homeTeam : game.awayTeam;
  }

  function simulateRemaining(scope) {
    const eligible = schedule2026.filter((game) =>
      !picks[game.id] && !isGameStarted(game) &&
      (scope === "season" || game.week === selectedWeek)
    );
    if (!eligible.length) {
      window.alert("No eligible unpicked games remain. Live and completed games are skipped.");
      return;
    }
    const label = scope === "season" ? "the rest of the season" : `Week ${selectedWeek}`;
    if (!window.confirm(`Simulate ${eligible.length} unpicked future games for ${label}? Existing picks will be kept.`)) return;
    setPicks((old) => {
      const next = { ...old };
      eligible.forEach((game) => { if (!next[game.id]) next[game.id] = simulateGame(game); });
      return next;
    });
  }

  function refreshScores() {
    window.dispatchEvent(new Event("nfl-refresh-scores"));
  }

  function handlePick(gameId, teamId) {
    if (isGameStarted(schedule2026.find((game) => game.id === gameId))) return;
    setPicks((old) => ({ ...old, [gameId]: teamId }));
  }

  function clearPicks() {
    const confirmClear = window.confirm(
      "Clear all picks for games that have NOT started? Locked picks will be preserved."
    );

    if (!confirmClear) {
      return;
    }

    setPicks((old) => {
      const next = { ...old };
      // Preserve locked picks so users cannot erase recorded contest results.
      schedule2026.forEach((game) => {
        if (!isGameStarted(game)) delete next[game.id];
      });
      return next;
    });
  }

  function clearSelectedWeekPicks() {
    const confirmClear = window.confirm(
      `Clear unstarted Week ${selectedWeek} picks? Locked picks will be preserved.`
    );

    if (!confirmClear) {
      return;
    }

    const updatedPicks = { ...picks };

    selectedWeekGames.forEach((game) => {
      if (!isGameStarted(game)) delete updatedPicks[game.id];
    });

    setPicks(updatedPicks);
  }

  function getProjectedRecord(teamId) {
    const stats = getTeamStats(teamId);
    return { wins: stats.wins, losses: stats.losses, ties: stats.ties };
  }

    function getTeamPickProgress(teamId) {
    const teamGames = schedule2026.filter(
      (game) => game.homeTeam === teamId || game.awayTeam === teamId
    );

    const pickedGames = teamGames.filter((game) => picks[game.id]);

    return {
      picked: pickedGames.length,
      total: teamGames.length,
      remaining: teamGames.length - pickedGames.length,
    };
  }

  function getWeekPickProgress(week) {
    const weekGames = schedule2026.filter((game) => game.week === week);
    const pickedGames = weekGames.filter((game) => picks[game.id]);

    const isComplete =
      weekGames.length > 0 && pickedGames.length === weekGames.length;

    let status = "Not Started";

    if (isComplete) {
      status = "Complete";
    } else if (pickedGames.length > 0) {
      status = "In Progress";
    }

    return {
      picked: pickedGames.length,
      total: weekGames.length,
      remaining: weekGames.length - pickedGames.length,
      isComplete,
      status,
    };
  }

  function getPct(wins, losses, ties = 0) {
    const total = wins + losses + ties;
    return total ? (wins + 0.5 * ties) / total : 0;
  }

  function getTeamStats(teamId) {
    const team = getTeamById(teamId);
    let wins = 0, losses = 0, ties = 0;
    let divisionWins = 0, divisionLosses = 0, divisionTies = 0;
    let conferenceWins = 0, conferenceLosses = 0, conferenceTies = 0;
    schedule2026.forEach((game) => {
      if (game.awayTeam !== teamId && game.homeTeam !== teamId) return;
      const winner = getEffectiveWinner(game);
      if (!winner) return;
      const opponentId = game.homeTeam === teamId ? game.awayTeam : game.homeTeam;
      const opponent = getTeamById(opponentId);
      const isTie = winner === TIE_PICK;
      const isWin = winner === teamId;
      if (isTie) ties += 1;
      else if (isWin) wins += 1;
      else losses += 1;
      if (opponent?.division === team?.division) {
        if (isTie) divisionTies += 1;
        else if (isWin) divisionWins += 1;
        else divisionLosses += 1;
      }
      if (opponent?.conference === team?.conference) {
        if (isTie) conferenceTies += 1;
        else if (isWin) conferenceWins += 1;
        else conferenceLosses += 1;
      }
    });
    return {
      wins, losses, ties,
      divisionWins, divisionLosses, divisionTies,
      conferenceWins, conferenceLosses, conferenceTies,
      winPct: getPct(wins, losses, ties),
      divisionPct: getPct(divisionWins, divisionLosses, divisionTies),
      conferencePct: getPct(conferenceWins, conferenceLosses, conferenceTies),
    };
  }

    function getHeadToHeadResult(teamAId, teamBId) {
    let teamAWins = 0;
    let teamBWins = 0;

    schedule2026.forEach((game) => {
      const selectedPick = getEffectiveWinner(game);
      if (!selectedPick) return;

      const teamsPlayed =
        (game.homeTeam === teamAId && game.awayTeam === teamBId) ||
        (game.homeTeam === teamBId && game.awayTeam === teamAId);

      if (!teamsPlayed) {
        return;
      }

      if (selectedPick === teamAId) {
        teamAWins += 1;
      }

      if (selectedPick === teamBId) {
        teamBWins += 1;
      }
    });

    return teamAWins - teamBWins;
  }

  function compareTeams(teamA, teamB) {
    const statsA = getTeamStats(teamA.id);
    const statsB = getTeamStats(teamB.id);

    if (statsB.winPct !== statsA.winPct) {
      return statsB.winPct - statsA.winPct;
    }

    const headToHead = getHeadToHeadResult(teamA.id, teamB.id);

    if (headToHead !== 0) {
      return -headToHead;
    }

    if (teamA.division === teamB.division) {
      if (statsB.divisionPct !== statsA.divisionPct) {
        return statsB.divisionPct - statsA.divisionPct;
      }
    }

    if (teamA.conference === teamB.conference) {
      if (statsB.conferencePct !== statsA.conferencePct) {
        return statsB.conferencePct - statsA.conferencePct;
      }
    }

    if (statsB.wins !== statsA.wins) {
      return statsB.wins - statsA.wins;
    }

    if (statsA.losses !== statsB.losses) {
      return statsA.losses - statsB.losses;
    }

    return teamA.name.localeCompare(teamB.name);
  }

  function getDivisionStandings() {
    const divisions = [...new Set(teams.map((team) => team.division))];

    return divisions.map((division) => {
      const divisionTeams = teams
        .filter((team) => team.division === division)
        .sort(compareTeams);

      return {
        division,
        teams: divisionTeams,
      };
    });
  }

  function getConferenceStandings(conference) {
    return teams
      .filter((team) => team.conference === conference)
      .sort(compareTeams);
  }

  function getPlayoffPicture(conference) {
    const conferenceTeams = teams.filter(
      (team) => team.conference === conference
    );

    const divisions = [...new Set(conferenceTeams.map((team) => team.division))];

    const divisionWinners = divisions
      .map((division) => {
        return conferenceTeams
          .filter((team) => team.division === division)
          .sort(compareTeams)[0];
      })
      .sort(compareTeams);

    const wildCardTeams = conferenceTeams
      .filter(
        (team) => !divisionWinners.some((winner) => winner.id === team.id)
      )
      .sort(compareTeams)
      .slice(0, 3);

    return [...divisionWinners, ...wildCardTeams];
  }

  function getOverallStandings() {
    return [...teams].sort(compareTeams);
  }

  function getTeamStandingData(team) {
    const stats = getTeamStats(team.id);
    const progress = getTeamPickProgress(team.id);

    return {
      ...team,
      ...stats,
      pickedGames: progress.picked,
      totalGames: progress.total,
    };
  }

  function renderTeamLogo(team, className = "team-logo-img") {
    if (!team) return null;
    if (team.logoImage) {
      return (
        <img
          src={team.logoImage}
          alt={`${team.name} logo`}
          className={className}
        />
      );
    }

    return <span>{team.logo}</span>;
  }

  function renderPickButtons(game) {
    const awayTeam = getTeamById(game.awayTeam);
    const homeTeam = getTeamById(game.homeTeam);
    const selectedPick = picks[game.id];
    const disabled = isGameStarted(game);
    return (
      <div className="matchup">
        <button className={selectedPick === awayTeam.id ? "pick-button selected" : "pick-button"}
          disabled={disabled} onClick={() => handlePick(game.id, awayTeam.id)}>
          {renderTeamLogo(awayTeam, "small-logo-img")} {awayTeam.name}
        </button>
        <span className="at-symbol">{game.neutralSite ? "vs" : "@"}</span>
        <button className={selectedPick === homeTeam.id ? "pick-button selected" : "pick-button"}
          disabled={disabled} onClick={() => handlePick(game.id, homeTeam.id)}>
          {renderTeamLogo(homeTeam, "small-logo-img")} {homeTeam.name}
        </button>
        <button className={selectedPick === TIE_PICK ? "pick-button selected tie-pick-button" : "pick-button tie-pick-button"}
          disabled={disabled} onClick={() => handlePick(game.id, TIE_PICK)}>
          Predict Tie
        </button>
      </div>
    );
  }

  function renderLiveScore(game) {
    const live = getLiveGame(game);
    if (!live) return null;
    const scoreVisible = live.state !== "pre" && Number.isFinite(live.awayScore) && Number.isFinite(live.homeScore);
    const label = live.state === "post" ? "Final" : live.state === "in" ? "Live" : "Scheduled";
    return (
      <div className={`live-score-strip status-${live.state}`}>
        <span className="score-status">{label}{live.detail ? ` · ${live.detail}` : ""}</span>
        {scoreVisible && <strong>{live.awayTeam} {live.awayScore} — {live.homeScore} {live.homeTeam}</strong>}
      </div>
    );
  }

  function renderPickedText(game) {
    const selectedPick = picks[game.id];
    const verdict = getPickEvaluation(game);
    const selectedTeamName = selectedPick === TIE_PICK ? "Tie" : getTeamById(selectedPick)?.name;
    const verdictLabels = { correct: "Correct ✓", wrong: "Incorrect ✕", push: "Tie / Push", pending: "Pending" };
    return (
      <p className="picked-text">
        Pick: {selectedPick ? selectedTeamName : "No pick yet"}
        {verdict && <span className={`pick-verdict verdict-${verdict}`}> · {verdictLabels[verdict]}</span>}
        {isGameStarted(game) && <span className="locked-note"> · Pick locked</span>}
      </p>
    );
  }

  function renderScoreControls() {
    return (
      <div className="score-controls">
        <span className="score-health">
          {scoreError ? scoreError : scoreSourceReady ? "Score feed connected · auto-refreshes every 2 min live / 10 min otherwise" : "Connecting to scores…"}
          {scoreCache.updatedAt && ` · Last checked ${new Date(scoreCache.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
        </span>
        <button className="score-refresh-button" onClick={refreshScores} disabled={scoreLoading}>
          {scoreLoading ? "Loading…" : "Refresh Scores"}
        </button>
      </div>
    );
  }

    function renderDashboard() {
    const afcOneSeed = afcPlayoffPicture[0];
    const nfcOneSeed = nfcPlayoffPicture[0];
    const topProjectedTeams = overallStandings.slice(0, 5);

    return (
      <>
        <div className="dashboard-hero">
          <div>
            <h2>Season Dashboard</h2>
            <p>
              Live NFL results, your picks, projected standings and playoff outlook.
            </p>
          </div>

          <button className="primary-action-button" onClick={() => setActiveTab("picks")}>
            Make Picks
          </button>
        </div>

        {renderScoreControls()}

        <div className="dashboard-grid">
          <div className="dashboard-card">
            <span>Total Picks</span>
            <strong>
              {totalPickedGames}/{totalGames}
            </strong>
            <p>{totalGames - totalPickedGames} games remaining</p>
          </div>

          <div className="dashboard-card">
            <span>Completed Weeks</span>
            <strong>
              {completedWeeks}/{availableWeeks.length}
            </strong>
            <p>{availableWeeks.length - completedWeeks} weeks still open</p>
          </div>

          <div className="dashboard-card">
            <span>Selected Team</span>
            <strong>{selectedTeam.name}</strong>
            <p>
              Actual + projected: {recordText(selectedTeamProjectedRecord)}
            </p>
          </div>

          <div className="dashboard-card">
            <span>Current 1 Seeds</span>
            <strong>
              {afcOneSeed ? afcOneSeed.name : "AFC TBD"} /{" "}
              {nfcOneSeed ? nfcOneSeed.name : "NFC TBD"}
            </strong>
            <p>Final results + picks for unplayed games</p>
          </div>
        </div>

        <div className="dashboard-grid result-summary-grid">
          <div className="dashboard-card"><span>Correct Picks</span><strong>{scoreCounts.correct}</strong></div>
          <div className="dashboard-card"><span>Incorrect Picks</span><strong>{scoreCounts.wrong}</strong></div>
          <div className="dashboard-card"><span>Tie / Push</span><strong>{scoreCounts.push}</strong></div>
          <div className="dashboard-card"><span>Pending Picks</span><strong>{scoreCounts.pending}</strong></div>
        </div>

        <div className="dashboard-two-column">
          <div className="dashboard-panel">
            <h2>Season Outlook (Results + Predictions)</h2>

            {topProjectedTeams.map((team, index) => {
              const data = getTeamStandingData(team);

              return (
                <button
                  className="dashboard-team-row"
                  key={team.id}
                  onClick={() => {
                    setSelectedTeamId(team.id);
                    setActiveTab("team");
                  }}
                >
                  <span>#{index + 1}</span>
                  <span>{renderTeamLogo(team, "small-logo-img")}</span>
                  <span>{team.name}</span>
                  <strong>
                    {recordText(data)}
                  </strong>
                </button>
              );
            })}
          </div>

          <div className="dashboard-panel contest-preview-panel">
            <h2>Contest Mode Preview</h2>

            <p>
              This app is still single-user right now, but the structure is
              getting ready for contests.
            </p>

            <div className="contest-preview-list">
              <span>Player: You</span>
              <span>Contest: 2026 NFL Pick’em</span>
              <span>Scoring: 1 point per correct pick</span>
              <span>Coming soon: login, groups, leaderboards</span>
            </div>
          </div>
        </div>

        {renderWeekCompletionTracker()}
      </>
    );
  }

  function renderWeekCompletionTracker() {
    return (
      <div className="week-completion-card">
        <div className="week-completion-header">
          <h2>Week Completion</h2>
          <p>
            Overall: {totalPickedGames} / {totalGames} games picked
          </p>
        </div>

        <div className="week-completion-grid">
          {availableWeeks.map((week) => {
            const progress = getWeekPickProgress(week);

            return (
              <button
                key={week}
                className={
                  selectedWeek === week
                    ? "week-completion-button active"
                    : progress.isComplete
                    ? "week-completion-button complete"
                    : progress.picked > 0
                    ? "week-completion-button in-progress"
                    : "week-completion-button"
                }
                onClick={() => {
                  setSelectedWeek(week);
                  setActiveTab("picks");
                }}
              >
                <span>Week {week}</span>

                <strong>
                  {progress.picked}/{progress.total}
                  {progress.isComplete ? " ✅" : ""}
                </strong>

                <small>{progress.status}</small>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderMyPicks() {
    const pickedGames = schedule2026.filter((game) => picks[game.id]);
    const filtered = myPicksWeekFilter === "all"
      ? pickedGames
      : pickedGames.filter((game) => game.week === Number(myPicksWeekFilter));
    const weeks = [...new Set(filtered.map((game) => game.week))];
    return (
      <>
        <div className="my-picks-controls">
          <label htmlFor="my-picks-week-filter">Filter by week:</label>
          <select id="my-picks-week-filter" value={myPicksWeekFilter}
            onChange={(event) => setMyPicksWeekFilter(event.target.value)}>
            <option value="all">All Weeks</option>
            {availableWeeks.map((week) => <option key={week} value={week}>Week {week}</option>)}
          </select>
        </div>
        {!filtered.length ? (
          <div className="summary-card"><p>{pickedGames.length ? "No picks for this week." : "You have not made any picks yet."}</p></div>
        ) : (
          <div className="my-picks-list">
            {weeks.map((week) => (
              <div className="my-picks-week" key={week}>
                <h2>Week {week}</h2>
                {filtered.filter((game) => game.week === week).map((game) => {
                  const away = getTeamById(game.awayTeam);
                  const home = getTeamById(game.homeTeam);
                  const choice = picks[game.id];
                  const pickName = choice === TIE_PICK ? "Tie" : getTeamById(choice)?.name;
                  const verdict = getPickEvaluation(game);
                  const labels = { correct: "Correct", wrong: "Incorrect", push: "Tie / Push", pending: "Pending" };
                  return (
                    <div className="my-pick-row" key={game.id}>
                      <div>
                        <strong>{renderTeamLogo(away, "small-logo-img")} {away.name} {game.neutralSite ? "vs" : "@"} {renderTeamLogo(home, "small-logo-img")} {home.name}</strong>
                        <p>Week {game.week} · {game.date} · {game.time}</p>
                        {renderLiveScore(game)}
                      </div>
                      <div className="my-pick-winner">
                        Pick: {pickName}
                        <span className={`pick-verdict verdict-${verdict}`}> · {labels[verdict]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

    function renderPickSummary() {
    return (
      <div className="summary-card">
        <h2>Pick Summary</h2>

        <p>
          Total Games Picked: {totalPickedGames} / {totalGames}
        </p>

        <p>Week {selectedWeek} Picks: {selectedWeekPickedGames} / {selectedWeekGames.length}</p>
        <p>Correct: {scoreCounts.correct} · Incorrect: {scoreCounts.wrong} · Pushes: {scoreCounts.push}</p>
      </div>
    );
  }

  function renderTeamSelectorAndCard() {
    return (
      <div className="top-section">
        <div>
          <div className="dropdown-section">
            <label htmlFor="team-select">Choose a team: </label>

            <select
              id="team-select"
              value={selectedTeamId}
              onChange={(event) => setSelectedTeamId(event.target.value)}
            >
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>

          <div
            className="showcase-card"
            style={{ borderColor: selectedTeam.primaryColor }}
          >
            <div className="showcase-logo">
              {renderTeamLogo(selectedTeam, "showcase-logo-img")}
            </div>

            <h2>{selectedTeam.name}</h2>

            <p>
              {selectedTeam.conference} {selectedTeam.division}
            </p>

            <p>
              Season Outlook: {recordText(selectedTeamProjectedRecord)}
            </p>

            <p>
              Games Picked: {selectedTeamPickProgress.picked} /{" "}
              {selectedTeamPickProgress.total}
            </p>

            <p>Remaining: {selectedTeamPickProgress.remaining}</p>
          </div>
        </div>

        {renderPickSummary()}
      </div>
    );
  }

  function renderWeekPicks() {
    return (
      <section className="picks-column">
        <div className="week-header">
          <h2>Week {selectedWeek} Picks</h2>
          <select value={selectedWeek}
            onChange={(event) => setSelectedWeek(Number(event.target.value))}>
            {availableWeeks.map((week) => <option key={week} value={week}>Week {week}</option>)}
          </select>
          <div className="week-action-buttons">
            <button className="sim-button" onClick={() => simulateRemaining("week")}>Sim Remaining Week {selectedWeek}</button>
            <button className="clear-button" onClick={clearSelectedWeekPicks}>Clear Week {selectedWeek}</button>
            <button className="sim-button" onClick={() => simulateRemaining("season")}>Sim Rest of Season</button>
            <button className="clear-button danger" onClick={clearPicks}>Clear Unlocked Picks</button>
          </div>
        </div>
        <p className="game-details">Simulator preserves manual picks and skips games that already started. Picks lock at kickoff.</p>
        {renderScoreControls()}
        <div className="pick-list">
          {selectedWeekGames.map((game) => (
            <div className="pick-game-card" key={game.id}>
              <div>
                <strong>Week {game.week}</strong>
                <p>{game.date} - {game.time}</p>
                <p className="game-details">{game.network}{game.neutralSite && game.location ? ` · ${game.location}` : ""}</p>
              </div>
              {renderLiveScore(game)}
              {renderPickButtons(game)}
              {renderPickedText(game)}
            </div>
          ))}
        </div>
      </section>
    );
  }

    function renderSelectedTeamSchedule() {
    return (
      <section className="picks-column">
        <h2>{selectedTeam.name} Schedule Picks</h2>

        <div className="team-schedule-pick-list">
          {selectedTeamSchedule.map((game) => (
            <div className="pick-game-card" key={game.id}>
              <div>
                <strong>Week {game.week}</strong>

                <p>
                  {game.date} - {game.time}
                </p>

                <p className="game-details">
                  {game.network}
                  {game.neutralSite && game.location
                    ? ` • ${game.location}`
                    : ""}
                </p>
              </div>

              {renderLiveScore(game)}
              {renderPickButtons(game)}

              {renderPickedText(game)}
            </div>
          ))}
        </div>
      </section>
    );
  }

  function renderStandingsTable(
    title,
    standings,
    rankLabel = "Rank",
    recordType = "conference"
  ) {
    return (
      <div className="standings-table">
        {title && <div className="standings-title">{title}</div>}

        <div className="standings-header">
          <span>{rankLabel}</span>
          <span>Team</span>
          <span>Record</span>
          <span>{recordType === "division" ? "Div" : "Conf"}</span>
        </div>

        {standings.map((team, index) => {
          const data = getTeamStandingData(team);

          return (
            <div className="standings-row" key={team.id}>
              <span>#{index + 1}</span>

              <span
                className="standings-team"
                onClick={() => {
                  setSelectedTeamId(team.id);
                  setActiveTab("team");
                }}
              >
                <span>{renderTeamLogo(team, "small-logo-img")}</span>
                <span>{team.name}</span>
              </span>

              <span>
                {recordText(data)}
              </span>

              <span>
                {recordType === "division"
                  ? `${data.divisionWins}-${data.divisionLosses}-${data.divisionTies}`
                  : `${data.conferenceWins}-${data.conferenceLosses}-${data.conferenceTies}`}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderTeamsGrid() {
    return (
      <>
        <h2>Teams</h2>

        <div className="team-grid">
          {teams.map((team) => {
            const teamProjectedRecord = getProjectedRecord(team.id);

            return (
              <div
                className="team-card"
                key={team.id}
                onClick={() => {
                  setSelectedTeamId(team.id);
                  setActiveTab("team");
                }}
              >
                <div className="team-logo">
                  {renderTeamLogo(team, "team-logo-img")}
                </div>

                <h3>{team.name}</h3>

                <p>
                  {team.conference} {team.division}
                </p>

                <p>
                  Season Outlook: {recordText(teamProjectedRecord)}
                </p>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <h1>NFL Pick'em App</h1>
      <p>Pick winners for the 2026-27 NFL season.</p>

      <div className="tab-nav">
        <button
          className={
            activeTab === "dashboard" ? "tab-button active" : "tab-button"
          }
          onClick={() => setActiveTab("dashboard")}
        >
          Dashboard
        </button>

        <button
          className={activeTab === "picks" ? "tab-button active" : "tab-button"}
          onClick={() => setActiveTab("picks")}
        >
          Picks
        </button>

        <button
          className={
            activeTab === "myPicks" ? "tab-button active" : "tab-button"
          }
          onClick={() => setActiveTab("myPicks")}
        >
          My Picks
        </button>

        <button
          className={activeTab === "team" ? "tab-button active" : "tab-button"}
          onClick={() => setActiveTab("team")}
        >
          Team View
        </button>

        <button
          className={
            activeTab === "standings" ? "tab-button active" : "tab-button"
          }
          onClick={() => setActiveTab("standings")}
        >
          Standings
        </button>

        <button
          className={
            activeTab === "playoffs" ? "tab-button active" : "tab-button"
          }
          onClick={() => setActiveTab("playoffs")}
        >
          Playoffs
        </button>

        <button
          className={activeTab === "teams" ? "tab-button active" : "tab-button"}
          onClick={() => setActiveTab("teams")}
        >
          Teams
        </button>
      </div>

      {activeTab === "dashboard" && renderDashboard()}

      {activeTab === "picks" && (
        <>
          {renderPickSummary()}
          {renderWeekCompletionTracker()}

          <div className="single-column-section">{renderWeekPicks()}</div>
        </>
      )}

      {activeTab === "myPicks" && (
        <>
          <h2>My Picks</h2>
          {renderMyPicks()}
        </>
      )}

      {activeTab === "team" && (
        <>
          {renderTeamSelectorAndCard()}

          <div className="single-column-section">
            {renderSelectedTeamSchedule()}
          </div>
        </>
      )}

      {activeTab === "standings" && (
        <>
          <h2>Division Standings (Final Results + Remaining Picks)</h2>

          <div className="division-standings-grid">
            {divisionStandings.map((divisionGroup) => (
              <div className="standings-table" key={divisionGroup.division}>
                <div className="standings-title">{divisionGroup.division}</div>

                <div className="standings-header">
                  <span>Rank</span>
                  <span>Team</span>
                  <span>Record</span>
                  <span>Div</span>
                </div>

                {divisionGroup.teams.map((team, index) => {
                  const data = getTeamStandingData(team);

                  return (
                    <div className="standings-row" key={team.id}>
                      <span>#{index + 1}</span>

                      <span
                        className="standings-team"
                        onClick={() => {
                          setSelectedTeamId(team.id);
                          setActiveTab("team");
                        }}
                      >
                        <span>{renderTeamLogo(team, "small-logo-img")}</span>
                        <span>{team.name}</span>
                      </span>

                      <span>
                        {recordText(data)}
                      </span>

                      <span>
                        {data.divisionWins}-{data.divisionLosses}-{data.divisionTies}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <h2>AFC Standings</h2>
          {renderStandingsTable("", afcStandings)}

          <h2>NFC Standings</h2>
          {renderStandingsTable("", nfcStandings)}
        </>
      )}

      {activeTab === "playoffs" && (
        <>
          <h2>Projected Playoff Picture (Final Results + Remaining Picks)</h2>

          <div className="playoff-picture">
            {renderStandingsTable(
              "AFC Playoff Seeds",
              afcPlayoffPicture,
              "Seed"
            )}
            {renderStandingsTable(
              "NFC Playoff Seeds",
              nfcPlayoffPicture,
              "Seed"
            )}
          </div>
        </>
      )}

      {activeTab === "teams" && renderTeamsGrid()}
    </div>
  );
}

export default App;