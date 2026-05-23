import { useEffect, useState } from "react";
import { teams } from "./data/teams";
import { schedule2026 } from "./data/schedule2026";
import "./App.css";

function App() {
  const [selectedTeamId, setSelectedTeamId] = useState("DET");
  const [selectedWeek, setSelectedWeek] = useState(1);
  const [activeTab, setActiveTab] = useState("picks");

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
  const totalPickedGames = Object.keys(picks).length;

  const selectedWeekPickedGames = selectedWeekGames.filter(
    (game) => picks[game.id]
  ).length;

  const divisionStandings = getDivisionStandings();
  const afcStandings = getConferenceStandings("AFC");
  const nfcStandings = getConferenceStandings("NFC");
  const afcPlayoffPicture = getPlayoffPicture("AFC");
  const nfcPlayoffPicture = getPlayoffPicture("NFC");

  function getTeamById(teamId) {
    return teams.find((team) => team.id === teamId);
  }

  function handlePick(gameId, teamId) {
    setPicks({
      ...picks,
      [gameId]: teamId,
    });
  }

  function clearPicks() {
    setPicks({});
  }

  function getProjectedRecord(teamId) {
    const stats = getTeamStats(teamId);

    return {
      wins: stats.wins,
      losses: stats.losses,
    };
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

  function getPct(wins, losses) {
    const total = wins + losses;

    if (total === 0) {
      return 0;
    }

    return wins / total;
  }

  function getTeamStats(teamId) {
    const team = getTeamById(teamId);

    let wins = 0;
    let losses = 0;
    let divisionWins = 0;
    let divisionLosses = 0;
    let conferenceWins = 0;
    let conferenceLosses = 0;

    schedule2026.forEach((game) => {
      const selectedPick = picks[game.id];

      if (!selectedPick) {
        return;
      }

      const isTeamInGame = game.homeTeam === teamId || game.awayTeam === teamId;

      if (!isTeamInGame) {
        return;
      }

      const opponentId =
        game.homeTeam === teamId ? game.awayTeam : game.homeTeam;
      const opponent = getTeamById(opponentId);
      const teamWon = selectedPick === teamId;

      if (teamWon) {
        wins += 1;
      } else {
        losses += 1;
      }

      if (opponent.division === team.division) {
        if (teamWon) {
          divisionWins += 1;
        } else {
          divisionLosses += 1;
        }
      }

      if (opponent.conference === team.conference) {
        if (teamWon) {
          conferenceWins += 1;
        } else {
          conferenceLosses += 1;
        }
      }
    });

    return {
      wins,
      losses,
      divisionWins,
      divisionLosses,
      conferenceWins,
      conferenceLosses,
      winPct: getPct(wins, losses),
      divisionPct: getPct(divisionWins, divisionLosses),
      conferencePct: getPct(conferenceWins, conferenceLosses),
    };
  }

  function getHeadToHeadResult(teamAId, teamBId) {
    let teamAWins = 0;
    let teamBWins = 0;

    schedule2026.forEach((game) => {
      const selectedPick = picks[game.id];

      if (!selectedPick) {
        return;
      }

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

    return (
      <div className="matchup">
        <button
          className={
            selectedPick === awayTeam.id
              ? "pick-button selected"
              : "pick-button"
          }
          onClick={() => handlePick(game.id, awayTeam.id)}
        >
          {renderTeamLogo(awayTeam, "small-logo-img")} {awayTeam.name}
        </button>

        <span className="at-symbol">{game.neutralSite ? "vs" : "@"}</span>

        <button
          className={
            selectedPick === homeTeam.id
              ? "pick-button selected"
              : "pick-button"
          }
          onClick={() => handlePick(game.id, homeTeam.id)}
        >
          {renderTeamLogo(homeTeam, "small-logo-img")} {homeTeam.name}
        </button>
      </div>
    );
  }

  function renderPickedText(game) {
    const selectedPick = picks[game.id];

    return (
      <p className="picked-text">
        Pick: {selectedPick ? getTeamById(selectedPick).name : "No pick yet"}
      </p>
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
              Projected Record: {selectedTeamProjectedRecord.wins}-
              {selectedTeamProjectedRecord.losses}
            </p>

            <p>
              Games Picked: {selectedTeamPickProgress.picked} /{" "}
              {selectedTeamPickProgress.total}
            </p>

            <p>Remaining: {selectedTeamPickProgress.remaining}</p>
          </div>
        </div>

        <div className="summary-card">
          <h2>Pick Summary</h2>

          <p>
            Total Games Picked: {totalPickedGames} / {totalGames}
          </p>

          <p>
            Week {selectedWeek} Picks: {selectedWeekPickedGames} /{" "}
            {selectedWeekGames.length}
          </p>
        </div>
      </div>
    );
  }

  function renderWeekPicks() {
    return (
      <section className="picks-column">
        <div className="week-header">
          <h2>Week {selectedWeek} Picks</h2>

          <select
            value={selectedWeek}
            onChange={(event) => setSelectedWeek(Number(event.target.value))}
          >
            {availableWeeks.map((week) => (
              <option key={week} value={week}>
                Week {week}
              </option>
            ))}
          </select>

          <button className="clear-button" onClick={clearPicks}>
            Clear Picks
          </button>
        </div>

        <div className="pick-list">
          {selectedWeekGames.map((game) => (
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
                {data.wins}-{data.losses}
              </span>

              <span>
                {recordType === "division"
                  ? `${data.divisionWins}-${data.divisionLosses}`
                  : `${data.conferenceWins}-${data.conferenceLosses}`}
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
                  Projected Record: {teamProjectedRecord.wins}-
                  {teamProjectedRecord.losses}
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
          className={activeTab === "picks" ? "tab-button active" : "tab-button"}
          onClick={() => setActiveTab("picks")}
        >
          Picks
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

      {activeTab === "picks" && (
        <>
          {renderTeamSelectorAndCard()}

          <div className="main-picks-layout">
            {renderWeekPicks()}
            {renderSelectedTeamSchedule()}
          </div>
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
          <h2>Division Standings</h2>

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
                        {data.wins}-{data.losses}
                      </span>

                      <span>
                        {data.divisionWins}-{data.divisionLosses}
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
          <h2>Projected Playoff Picture</h2>

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