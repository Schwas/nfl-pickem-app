
import { useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabase";
import { teams } from "./data/teams";
import { schedule2026 } from "./data/schedule2026";
import "./App.css";

// Real final results override simulated outcomes.
const SCORE_ENDPOINT = "/.netlify/functions/nfl-scores";
const SCORE_REFRESH_MS = 120000;
const SCORES_CACHE_KEY = "nfl-pickem-score-cache-2026";
const LOCAL_PICKS_KEY = "nfl-pickem-picks";
const TIE_PICK = "TIE";
const PICK_SEASON = 2026;

// Illustrative simulation ratings, not betting odds.
const SIM_STRENGTH = {
  ARI: 71, ATL: 79, BAL: 89, BUF: 92,
  CAR: 70, CHI: 80, CIN: 85, CLE: 69,
  DAL: 79, DEN: 85, DET: 89, GB: 85,
  HOU: 83, IND: 78, JAX: 77, KC: 90,
  LAC: 84, LAR: 87, LV: 70, MIA: 76,
  MIN: 82, NE: 77, NO: 70, NYG: 71,
  NYJ: 72, PHI: 90, PIT: 82, SEA: 85,
  SF: 84, TB: 81, TEN: 69, WAS: 81,
};

function easternDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const read = (kind) =>
    parts.find((part) => part.type === kind)?.value;

  return `${read("year")}-${read("month")}-${read("day")}`;
}

function currentScheduleWeek() {
  const today = easternDateKey();

  const startedWeeks = schedule2026
    .filter(
      (game) =>
        /^\d{4}-\d{2}-\d{2}$/.test(game.date) &&
        game.date <= today
    )
    .map((game) => Number(game.week));

  return Math.max(1, ...startedWeeks);
}

function scoreboardKey(game) {
  return `${game.week}:${game.awayTeam}:${game.homeTeam}`;
}

function safeScoreCache() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SCORES_CACHE_KEY) || "null"
    );

    if (
      saved &&
      typeof saved.games === "object" &&
      saved.games
    ) {
      return saved;
    }
  } catch {
    // Invalid cache should not prevent the app from loading.
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

  // Live NFL scores
  const [scoreCache, setScoreCache] = useState(safeScoreCache);
  const [scoreError, setScoreError] = useState("");
  const [scoreLoading, setScoreLoading] = useState(false);
  const [scoreSourceReady, setScoreSourceReady] = useState(false);

  // Guest picks
  const [guestPicks, setGuestPicks] = useState(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem(LOCAL_PICKS_KEY) || "{}"
      );

      return value &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? value
        : {};
    } catch {
      return {};
    }
  });

  // Supabase authentication
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [authView, setAuthView] = useState("signin");
  const [authBusy, setAuthBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [authError, setAuthError] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // Cloud picks
  const [cloudPicks, setCloudPicks] = useState({});
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [cloudRefreshToken, setCloudRefreshToken] = useState(0);

  // User profile
  const [profile, setProfile] = useState(null);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [favoriteTeamDraft, setFavoriteTeamDraft] = useState("");

  const previousUserId = useRef(null);

  const userId = session?.user?.id || null;
  const picks = session ? cloudPicks : guestPicks;
  const picksEditable = !session || (cloudReady && !cloudBusy);

  // Save guest picks locally.
  useEffect(() => {
    try {
      localStorage.setItem(
        LOCAL_PICKS_KEY,
        JSON.stringify(guestPicks)
      );
    } catch {
      // Local storage is optional.
    }
  }, [guestPicks]);

  // Authentication session listener.
  useEffect(() => {
    if (!supabase) return;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (event, nextSession) => {
        const nextId = nextSession?.user?.id || null;

        if (previousUserId.current !== nextId) {
          previousUserId.current = nextId;
          setCloudPicks({});
          setCloudReady(false);
          setCloudError("");
          setProfile(null);
        }

        setSession(nextSession);
        setAuthReady(true);

        if (event === "PASSWORD_RECOVERY") {
          setAuthView("update-password");
          setActiveTab("account");
          setAuthNotice(
            "Enter a new password below to finish resetting your account."
          );
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Load signed-in user's cloud picks and profile.
  useEffect(() => {
    if (!supabase || !userId) {
      setCloudReady(false);
      return;
    }

    let cancelled = false;

    setCloudReady(false);
    setCloudError("");

    async function loadAccount() {
      const [pickResult, profileResult] = await Promise.all([
        supabase
          .from("user_picks")
          .select("game_id,pick")
          .eq("user_id", userId)
          .eq("season", PICK_SEASON),

        supabase
          .from("profiles")
          .select("display_name,favorite_team")
          .eq("id", userId)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      if (pickResult.error) {
        setCloudError(
          `Couldn't load your cloud picks: ${pickResult.error.message}`
        );
        return;
      }

      const allowedIds = new Set(
        schedule2026.map((game) => game.id)
      );

      const nextPicks = {};

      for (const row of pickResult.data || []) {
        if (
          allowedIds.has(row.game_id) &&
          typeof row.pick === "string"
        ) {
          nextPicks[row.game_id] = row.pick;
        }
      }

      setCloudPicks(nextPicks);
      setCloudReady(true);

      if (profileResult.error) {
        setCloudError(
          `Your picks loaded, but your profile couldn't load: ${profileResult.error.message}`
        );
      } else {
        const currentProfile = profileResult.data;

        setProfile(currentProfile);
        setProfileNameDraft(
          currentProfile?.display_name ||
            session?.user?.user_metadata?.display_name ||
            ""
        );
        setFavoriteTeamDraft(
          currentProfile?.favorite_team || ""
        );
      }
    }

    loadAccount().catch((error) => {
      if (!cancelled) {
        setCloudError(
          `Couldn't load your account: ${error.message}`
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [userId, cloudRefreshToken]);

  // Reload cloud picks when returning to the browser.
  useEffect(() => {
    if (!userId) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setCloudRefreshToken((value) => value + 1);
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () =>
      document.removeEventListener("visibilitychange", onVisible);
  }, [userId]);

  // Live NFL score loading.
  useEffect(() => {
    let disposed = false;
    let liveGamesActive = false;
    let lastBackgroundCheck = Date.now();

    const controller = new AbortController();

    async function loadScores(fullSeasonHistory = false) {
      if (
        disposed ||
        document.visibilityState === "hidden"
      ) {
        return;
      }

      const week = currentScheduleWeek();

      const parameters = fullSeasonHistory
        ? `throughWeek=${week}`
        : `weeks=${[
            Math.max(1, week - 1),
            week,
          ].join(",")}`;

      setScoreLoading(true);

      try {
        const response = await fetch(
          `${SCORE_ENDPOINT}?${parameters}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error(
            `Score service returned ${response.status}`
          );
        }

        const payload = await response.json();

        if (
          !Array.isArray(payload.games) ||
          !Array.isArray(payload.weeksLoaded)
        ) {
          throw new Error("Unexpected scoreboard response");
        }

        if (disposed) return;

        setScoreCache((previous) => {
          const updated = { ...previous.games };
          const received = new Set(payload.weeksLoaded);

          for (const key of Object.keys(updated)) {
            if (
              received.has(
                Number(key.split(":")[0])
              )
            ) {
              delete updated[key];
            }
          }

          for (const game of payload.games) {
            const validState = [
              "pre",
              "in",
              "post",
            ].includes(game.state);

            if (
              !validState ||
              !Number.isInteger(game.week) ||
              !game.awayTeam ||
              !game.homeTeam
            ) {
              continue;
            }

            updated[scoreboardKey(game)] = game;
          }

          const next = {
            games: updated,
            updatedAt: new Date().toISOString(),
          };

          try {
            localStorage.setItem(
              SCORES_CACHE_KEY,
              JSON.stringify(next)
            );
          } catch {
            // Cache is optional.
          }

          return next;
        });

        liveGamesActive = payload.games.some(
          (game) => game.state === "in"
        );

        setScoreSourceReady(true);

        setScoreError(
          payload.weeksFailed?.length
            ? `Could not load Week ${payload.weeksFailed.join(
                ", "
              )} scores.`
            : ""
        );
      } catch (error) {
        if (
          !disposed &&
          error.name !== "AbortError"
        ) {
          setScoreError(
            "Live scores are unavailable right now. Showing last cached results if present."
          );
        }
      } finally {
        if (!disposed) {
          setScoreLoading(false);
        }
      }
    }

    loadScores(true);

    const interval = window.setInterval(() => {
      if (
        liveGamesActive ||
        Date.now() - lastBackgroundCheck >= 600000
      ) {
        lastBackgroundCheck = Date.now();
        loadScores(false);
      }
    }, SCORE_REFRESH_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadScores(true);
      }
    };

    const onRefresh = () => loadScores(true);

    document.addEventListener(
      "visibilitychange",
      onVisible
    );

    window.addEventListener(
      "nfl-refresh-scores",
      onRefresh
    );

    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);

      document.removeEventListener(
        "visibilitychange",
        onVisible
      );

      window.removeEventListener(
        "nfl-refresh-scores",
        onRefresh
      );
    };
  }, []);

  // Derived data
  const selectedTeam = getTeamById(selectedTeamId);
  const selectedTeamProjectedRecord =
    getProjectedRecord(selectedTeamId);
  const selectedTeamPickProgress =
    getTeamPickProgress(selectedTeamId);

  const selectedTeamSchedule = schedule2026.filter(
    (game) =>
      game.homeTeam === selectedTeamId ||
      game.awayTeam === selectedTeamId
  );

  const selectedWeekGames = schedule2026.filter(
    (game) => game.week === selectedWeek
  );

  const availableWeeks = [
    ...new Set(
      schedule2026.map((game) => game.week)
    ),
  ];

  const totalGames = schedule2026.length;

  const totalPickedGames = schedule2026.filter(
    (game) => Boolean(picks[game.id])
  ).length;

  const scoreCounts = {
    correct: 0,
    wrong: 0,
    push: 0,
    pending: 0,
  };

  schedule2026.forEach((game) => {
    if (!picks[game.id]) return;

    const outcome = getPickEvaluation(game);

    if (outcome in scoreCounts) {
      scoreCounts[outcome] += 1;
    }
  });

  const selectedWeekPickedGames =
    selectedWeekGames.filter(
      (game) => picks[game.id]
    ).length;

  const completedWeeks = availableWeeks.filter(
    (week) => getWeekPickProgress(week).allGamesFinal
  ).length;

  const divisionStandings = getDivisionStandings();
  const afcStandings = getConferenceStandings("AFC");
  const nfcStandings = getConferenceStandings("NFC");

  const afcPlayoffPicture = getPlayoffPicture("AFC");
  const nfcPlayoffPicture = getPlayoffPicture("NFC");

  // NEW: First three teams outside each playoff field.
  const afcInTheHunt = getPlayoffPicture("AFC", 10).slice(7);
  const nfcInTheHunt = getPlayoffPicture("NFC", 10).slice(7);

  const overallStandings = getOverallStandings();

  // Cloud storage helpers
  function requestCloudReload() {
    setCloudRefreshToken((count) => count + 1);
  }

  async function writePickChanges(
    additions = [],
    removals = []
  ) {
    if (
      session &&
      (!cloudReady || cloudBusy)
    ) {
      return;
    }

    if (!session) {
      setGuestPicks((previous) => {
        const next = { ...previous };

        additions.forEach(([id, pick]) => {
          next[id] = pick;
        });

        removals.forEach((id) => {
          delete next[id];
        });

        return next;
      });

      return;
    }

    const ownerId = session.user.id;

    setCloudBusy(true);
    setCloudError("");

    try {
      if (additions.length) {
        const rows = additions.map(
          ([gameId, pick]) => ({
            user_id: ownerId,
            season: PICK_SEASON,
            game_id: gameId,
            pick,
          })
        );

        const { error } = await supabase
          .from("user_picks")
          .upsert(rows, {
            onConflict:
              "user_id,season,game_id",
          });

        if (error) throw error;
      }

      if (removals.length) {
        const { error } = await supabase
          .from("user_picks")
          .delete()
          .eq("user_id", ownerId)
          .eq("season", PICK_SEASON)
          .in("game_id", removals);

        if (error) throw error;
      }

      requestCloudReload();
    } catch (error) {
      setCloudError(
        `Unable to save picks: ${error.message}. Your cloud data has not been confirmed.`
      );

      requestCloudReload();
    } finally {
      setCloudBusy(false);
    }
  }

  async function importBrowserPicks() {
    if (
      !session ||
      !cloudReady ||
      cloudBusy
    ) {
      return;
    }

    const allowed = new Set(
      schedule2026.map((game) => game.id)
    );

    const missing = Object.entries(guestPicks).filter(
      ([gameId, pick]) => {
        const game = schedule2026.find(
          (g) => g.id === gameId
        );

        return (
          allowed.has(gameId) &&
          !cloudPicks[gameId] &&
          typeof pick === "string" &&
          (
            pick === TIE_PICK ||
            [
              game?.awayTeam,
              game?.homeTeam,
            ].includes(pick)
          )
        );
      }
    );

    if (!missing.length) {
      setAuthNotice(
        "All your local picks are already in this account."
      );
      return;
    }

    if (
      !window.confirm(
        `Import ${missing.length} saved browser picks into this account? Existing cloud picks will not be replaced.`
      )
    ) {
      return;
    }

    setCloudBusy(true);
    setCloudError("");

    try {
      const rows = missing.map(
        ([gameId, pick]) => ({
          user_id: session.user.id,
          season: PICK_SEASON,
          game_id: gameId,
          pick,
        })
      );

      const { error } = await supabase
        .from("user_picks")
        .upsert(rows, {
          onConflict:
            "user_id,season,game_id",
          ignoreDuplicates: true,
        });

      if (error) throw error;

      setAuthNotice(
        "Your browser picks were imported. The originals remain on this device."
      );

      requestCloudReload();
    } catch (error) {
      setCloudError(
        `Import failed: ${error.message}`
      );

      requestCloudReload();
    } finally {
      setCloudBusy(false);
    }
  }

  // Authentication
  async function submitAuthentication(event) {
    event.preventDefault();

    if (!supabase || authBusy) return;

    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");

    try {
      const email = authEmail
        .trim()
        .toLowerCase();

      if (authView === "signup") {
        const displayName = authName.trim();

        if (
          displayName.length < 2 ||
          displayName.length > 40
        ) {
          throw new Error(
            "Username must be 2–40 characters."
          );
        }

        if (authPassword.length < 6) {
          throw new Error(
            "Password must be at least 6 characters."
          );
        }

        const { data, error } =
          await supabase.auth.signUp({
            email,
            password: authPassword,
            options: {
              data: {
                display_name: displayName,
              },
              emailRedirectTo:
                window.location.origin + "/",
            },
          });

        if (error) throw error;

        setAuthPassword("");

        setAuthNotice(
          data.session
            ? "Account created! Your cloud picks are now available."
            : "If this address can register, check your email for a confirmation link, then sign in."
        );
      } else if (authView === "forgot") {
        const { error } =
          await supabase.auth.resetPasswordForEmail(
            email,
            {
              redirectTo:
                window.location.origin + "/",
            }
          );

        if (error) throw error;

        setAuthNotice(
          "If an account exists for this email, a reset link will be sent."
        );
      } else {
        const { error } =
          await supabase.auth.signInWithPassword({
            email,
            password: authPassword,
          });

        if (error) throw error;

        setAuthPassword("");
        setAuthNotice(
          "You are signed in. Your cloud picks are loading."
        );
      }
    } catch (error) {
      setAuthError(
        error.message || "Authentication failed."
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();

    if (
      !supabase ||
      newPassword.length < 6
    ) {
      setAuthError(
        "Your new password must be at least 6 characters."
      );
      return;
    }

    setAuthBusy(true);
    setAuthError("");

    try {
      const { error } =
        await supabase.auth.updateUser({
          password: newPassword,
        });

      if (error) throw error;

      setNewPassword("");
      setAuthView("signin");
      setAuthNotice(
        "Password updated successfully."
      );
    } catch (error) {
      setAuthError(
        error.message || "Couldn't update password."
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();

    if (!session || !supabase) return;

    const name = profileNameDraft.trim();

    if (
      name.length < 2 ||
      name.length > 40
    ) {
      setAuthError(
        "Username must be 2–40 characters."
      );
      return;
    }

    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");

    try {
      const nextProfile = {
        id: session.user.id,
        display_name: name,
        favorite_team:
          favoriteTeamDraft || null,
      };

      const { error } = await supabase
        .from("profiles")
        .upsert(nextProfile, {
          onConflict: "id",
        });

      if (error) throw error;

      setProfile(nextProfile);
      setAuthNotice(
        "Profile saved to your account."
      );
    } catch (error) {
      setAuthError(
        `Profile not saved: ${error.message}`
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;

    setAuthBusy(true);
    setAuthError("");

    const { error } =
      await supabase.auth.signOut();

    if (error) {
      setAuthError(error.message);
    } else {
      setAuthNotice(
        "Signed out. Your guest picks on this browser are still saved."
      );
    }

    setAuthBusy(false);
  }

  function renderAccount() {
    if (!supabaseConfigured) {
      return (
        <section className="account-card">
          <h2>Connect account storage</h2>
          <p>
            Guest mode is working. To enable logins,
            create a Supabase project, run the included
            SQL, and add the two VITE_SUPABASE
            environment variables.
          </p>
          <p className="account-muted">
            Do not enter a Supabase secret or service-role
            key in the website.
          </p>
        </section>
      );
    }

    return (
      <div className="account-layout">
        <section className="account-card">
          <h2>
            {session
              ? "My Account"
              : authView === "signup"
              ? "Create Account"
              : authView === "forgot"
              ? "Reset Password"
              : "Sign In"}
          </h2>

          {authNotice && (
            <p
              className="account-success"
              role="status"
            >
              {authNotice}
            </p>
          )}

          {authError && (
            <p
              className="account-error"
              role="alert"
            >
              {authError}
            </p>
          )}

          {!authReady && (
            <p>Checking your session…</p>
          )}

          {authView === "update-password" &&
          session ? (
            <form
              className="account-form"
              onSubmit={changePassword}
            >
              <label htmlFor="account-new-password">
                New password
              </label>

              <input
                id="account-new-password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
                value={newPassword}
                onChange={(e) =>
                  setNewPassword(e.target.value)
                }
              />

              <button
                className="primary-action-button"
                type="submit"
                disabled={authBusy}
              >
                Save New Password
              </button>
            </form>
          ) : session ? (
            <>
              <p>
                Signed in as{" "}
                <strong>
                  {session.user.email}
                </strong>
              </p>

              <p className="account-muted">
                Your picks are stored under this account,
                separate from guest picks.
              </p>

              <div className="account-status">
                {cloudBusy
                  ? "Saving picks…"
                  : cloudReady
                  ? `Cloud synced · ${
                      Object.keys(cloudPicks).length
                    } picks`
                  : "Loading your cloud picks…"}
              </div>

              {cloudError && (
                <p
                  className="account-error"
                  role="alert"
                >
                  {cloudError}
                </p>
              )}

              <div className="account-actions">
                <button
                  type="button"
                  className="account-secondary-button"
                  onClick={requestCloudReload}
                  disabled={cloudBusy}
                >
                  Reload Cloud Picks
                </button>

                <button
                  type="button"
                  className="account-secondary-button"
                  onClick={importBrowserPicks}
                  disabled={
                    !cloudReady || cloudBusy
                  }
                >
                  Import{" "}
                  {
                    Object.keys(guestPicks)
                      .length
                  }{" "}
                  Browser Picks
                </button>

                <button
                  type="button"
                  className="clear-button"
                  onClick={signOut}
                  disabled={authBusy}
                >
                  Sign Out
                </button>
              </div>

              <p className="account-muted">
                Import only adds picks missing from your
                account. Existing cloud picks will not
                be replaced.
              </p>
            </>
          ) : authReady ? (
            <>
              <p className="account-muted">
                Save your predictions across computers
                and phones. You can also keep using
                the app as a guest.
              </p>

              <form
                className="account-form"
                onSubmit={submitAuthentication}
              >
                {authView === "signup" && (
                  <>
                    <label htmlFor="account-name">
                      Display name
                    </label>

                    <input
                      id="account-name"
                      value={authName}
                      maxLength={40}
                      minLength={2}
                      required
                      onChange={(e) =>
                        setAuthName(e.target.value)
                      }
                      placeholder="Your pick'em nickname"
                    />
                  </>
                )}

                <label htmlFor="account-email">
                  Email
                </label>

                <input
                  id="account-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={authEmail}
                  onChange={(e) =>
                    setAuthEmail(e.target.value)
                  }
                  placeholder="you@example.com"
                />

                {authView !== "forgot" && (
                  <>
                    <label htmlFor="account-password">
                      Password
                    </label>

                    <input
                      id="account-password"
                      type="password"
                      minLength={6}
                      autoComplete={
                        authView === "signup"
                          ? "new-password"
                          : "current-password"
                      }
                      required
                      value={authPassword}
                      onChange={(e) =>
                        setAuthPassword(e.target.value)
                      }
                    />
                  </>
                )}

                <button
                  className="primary-action-button"
                  type="submit"
                  disabled={authBusy}
                >
                  {authBusy
                    ? "Please wait…"
                    : authView === "signup"
                    ? "Create Account"
                    : authView === "forgot"
                    ? "Email Reset Link"
                    : "Sign In"}
                </button>
              </form>

              <div className="account-actions">
                <button
                  type="button"
                  className="account-text-button"
                  onClick={() => {
                    setAuthView(
                      authView === "signup"
                        ? "signin"
                        : "signup"
                    );
                    setAuthError("");
                  }}
                >
                  {authView === "signup"
                    ? "Already have an account? Sign in"
                    : "Need an account? Sign up"}
                </button>

                <button
                  type="button"
                  className="account-text-button"
                  onClick={() => {
                    setAuthView(
                      authView === "forgot"
                        ? "signin"
                        : "forgot"
                    );
                    setAuthError("");
                  }}
                >
                  {authView === "forgot"
                    ? "Back to sign in"
                    : "Forgot password?"}
                </button>
              </div>
            </>
          ) : null}
        </section>

        {session && (
          <section className="account-card">
            <h2>Your Profile</h2>

            <form
              className="account-form"
              onSubmit={saveProfile}
            >
              <label htmlFor="profile-name">
                Display name
              </label>

              <input
                id="profile-name"
                maxLength={40}
                minLength={2}
                required
                value={profileNameDraft}
                onChange={(e) =>
                  setProfileNameDraft(e.target.value)
                }
                placeholder="Your nickname"
              />

              <label htmlFor="favorite-team">
                Favorite NFL team
              </label>

              <select
                id="favorite-team"
                value={favoriteTeamDraft}
                onChange={(e) =>
                  setFavoriteTeamDraft(e.target.value)
                }
              >
                <option value="">
                  None selected
                </option>

                {teams.map((team) => (
                  <option
                    key={team.id}
                    value={team.id}
                  >
                    {team.name}
                  </option>
                ))}
              </select>

              <button
                className="primary-action-button"
                type="submit"
                disabled={
                  authBusy || !cloudReady
                }
              >
                Save Profile
              </button>
            </form>

            {profile?.favorite_team && (
              <button
                className="account-secondary-button"
                type="button"
                onClick={() => {
                  setSelectedTeamId(
                    profile.favorite_team
                  );
                  setActiveTab("team");
                }}
              >
                View Favorite Team
              </button>
            )}
          </section>
        )}
      </div>
    );
  }

  // Team and game helpers
  function getTeamById(teamId) {
    return teams.find(
      (team) => team.id === teamId
    );
  }

  function getLiveGame(game) {
    return scoreCache.games[
      scoreboardKey(game)
    ];
  }

  function getActualWinner(game) {
    const score = getLiveGame(game);

    if (
      !score ||
      score.state !== "post" ||
      !Number.isFinite(score.awayScore) ||
      !Number.isFinite(score.homeScore)
    ) {
      return null;
    }

    if (
      score.awayScore === score.homeScore
    ) {
      return TIE_PICK;
    }

    return score.awayScore > score.homeScore
      ? game.awayTeam
      : game.homeTeam;
  }

  function getEffectiveWinner(game) {
    return (
      getActualWinner(game) ||
      picks[game.id] ||
      null
    );
  }

  function getPickEvaluation(game) {
    const pick = picks[game.id];

    if (!pick) return null;

    const actual = getActualWinner(game);

    if (!actual) return "pending";

    if (
      actual === TIE_PICK &&
      pick !== TIE_PICK
    ) {
      return "push";
    }

    return pick === actual
      ? "correct"
      : "wrong";
  }

  function isGameStarted(game) {
    const score = getLiveGame(game);

    if (score) {
      if (
        score.state === "in" ||
        score.state === "post"
      ) {
        return true;
      }

      if (
        score.kickoff &&
        Number.isFinite(
          new Date(score.kickoff).getTime()
        )
      ) {
        return (
          new Date(score.kickoff).getTime() <=
          Date.now()
        );
      }

      return false;
    }

    // Fallback when live scores are unavailable.
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(
        game.date
      ) &&
      game.date < easternDateKey()
    );
  }

  // Auto-pick simulator
  function simulateGame(game) {
    const away =
      SIM_STRENGTH[game.awayTeam] ?? 78;

    const home =
      SIM_STRENGTH[game.homeTeam] ?? 78;

    const difference =
      home +
      (game.neutralSite ? 0 : 3) -
      away;

    const homeChance = Math.min(
      0.83,
      Math.max(
        0.17,
        0.5 + difference * 0.015
      )
    );

    return Math.random() < homeChance
      ? game.homeTeam
      : game.awayTeam;
  }

  function simulateRemaining(scope) {
    const eligible = schedule2026.filter(
      (game) =>
        !picks[game.id] &&
        !isGameStarted(game) &&
        (
          scope === "season" ||
          game.week === selectedWeek
        )
    );

    if (!picksEditable) return;

    if (!eligible.length) {
      window.alert(
        "No eligible unpicked games remain. Live and completed games are skipped."
      );
      return;
    }

    const label =
      scope === "season"
        ? "the rest of the season"
        : `Week ${selectedWeek}`;

    if (
      !window.confirm(
        `Simulate ${eligible.length} unpicked future games for ${label}? Existing picks will be kept.`
      )
    ) {
      return;
    }

    void writePickChanges(
      eligible.map((game) => [
        game.id,
        simulateGame(game),
      ])
    );
  }

  function refreshScores() {
    window.dispatchEvent(
      new Event("nfl-refresh-scores")
    );
  }

  function handlePick(gameId, teamId) {
    const game = schedule2026.find(
      (item) => item.id === gameId
    );

    if (
      !game ||
      isGameStarted(game) ||
      !picksEditable
    ) {
      return;
    }

    void writePickChanges([
      [gameId, teamId],
    ]);
  }

  function clearPicks() {
    if (!picksEditable) return;

    if (
      !window.confirm(
        "Clear all picks for games that have NOT started? Locked picks will be preserved."
      )
    ) {
      return;
    }

    const ids = schedule2026
      .filter(
        (game) =>
          !isGameStarted(game) &&
          picks[game.id]
      )
      .map((game) => game.id);

    void writePickChanges([], ids);
  }

  function clearSelectedWeekPicks() {
    if (!picksEditable) return;

    if (
      !window.confirm(
        `Clear unstarted Week ${selectedWeek} picks? Locked picks will be preserved.`
      )
    ) {
      return;
    }

    const ids = selectedWeekGames
      .filter(
        (game) =>
          !isGameStarted(game) &&
          picks[game.id]
      )
      .map((game) => game.id);

    void writePickChanges([], ids);
  }

  // Records and standings
  function getProjectedRecord(teamId) {
    const stats = getTeamStats(teamId);

    return {
      wins: stats.wins,
      losses: stats.losses,
      ties: stats.ties,
    };
  }

  function getTeamPickProgress(teamId) {
    const teamGames = schedule2026.filter(
      (game) =>
        game.homeTeam === teamId ||
        game.awayTeam === teamId
    );

    const pickedGames = teamGames.filter(
      (game) => picks[game.id]
    );

    return {
      picked: pickedGames.length,
      total: teamGames.length,
      remaining:
        teamGames.length -
        pickedGames.length,
    };
  }

  // NEW: Track actual final games separately from picks.
  function getWeekPickProgress(week) {
    const weekGames = schedule2026.filter(
      (game) => game.week === week
    );

    const pickedGames = weekGames.filter(
      (game) =>
        Boolean(picks[game.id])
    );

    const finalGames = weekGames.filter(
      (game) =>
        getActualWinner(game) !== null
    ).length;

    const allGamesFinal =
      weekGames.length > 0 &&
      finalGames === weekGames.length;

    const allPicked =
      weekGames.length > 0 &&
      pickedGames.length ===
        weekGames.length;

    let status = "Not Started";

    if (allGamesFinal) {
      status = "All Games Final";
    } else if (allPicked) {
      status = "Picks Complete";
    } else if (
      pickedGames.length > 0 ||
      finalGames > 0
    ) {
      status = "In Progress";
    }

    return {
      picked: pickedGames.length,
      total: weekGames.length,
      final: finalGames,
      remaining:
        weekGames.length -
        pickedGames.length,
      isComplete:
        allGamesFinal || allPicked,
      allGamesFinal,
      allPicked,
      status,
    };
  }

  function getPct(
    wins,
    losses,
    ties = 0
  ) {
    const total =
      wins + losses + ties;

    return total
      ? (wins + 0.5 * ties) / total
      : 0;
  }

  function getTeamStats(teamId) {
    const team = getTeamById(teamId);

    let wins = 0;
    let losses = 0;
    let ties = 0;

    let divisionWins = 0;
    let divisionLosses = 0;
    let divisionTies = 0;

    let conferenceWins = 0;
    let conferenceLosses = 0;
    let conferenceTies = 0;

    schedule2026.forEach((game) => {
      if (
        game.awayTeam !== teamId &&
        game.homeTeam !== teamId
      ) {
        return;
      }

      const winner =
        getEffectiveWinner(game);

      if (!winner) return;

      const opponentId =
        game.homeTeam === teamId
          ? game.awayTeam
          : game.homeTeam;

      const opponent =
        getTeamById(opponentId);

      const isTie =
        winner === TIE_PICK;

      const isWin =
        winner === teamId;

      if (isTie) {
        ties += 1;
      } else if (isWin) {
        wins += 1;
      } else {
        losses += 1;
      }

      if (
        opponent?.division ===
        team?.division
      ) {
        if (isTie) {
          divisionTies += 1;
        } else if (isWin) {
          divisionWins += 1;
        } else {
          divisionLosses += 1;
        }
      }

      if (
        opponent?.conference ===
        team?.conference
      ) {
        if (isTie) {
          conferenceTies += 1;
        } else if (isWin) {
          conferenceWins += 1;
        } else {
          conferenceLosses += 1;
        }
      }
    });

    return {
      wins,
      losses,
      ties,
      divisionWins,
      divisionLosses,
      divisionTies,
      conferenceWins,
      conferenceLosses,
      conferenceTies,
      winPct: getPct(
        wins,
        losses,
        ties
      ),
      divisionPct: getPct(
        divisionWins,
        divisionLosses,
        divisionTies
      ),
      conferencePct: getPct(
        conferenceWins,
        conferenceLosses,
        conferenceTies
      ),
    };
  }

  function getHeadToHeadResult(
    teamAId,
    teamBId
  ) {
    let teamAWins = 0;
    let teamBWins = 0;

    schedule2026.forEach((game) => {
      const winner =
        getEffectiveWinner(game);

      if (!winner) return;

      const teamsPlayed =
        (
          game.homeTeam === teamAId &&
          game.awayTeam === teamBId
        ) ||
        (
          game.homeTeam === teamBId &&
          game.awayTeam === teamAId
        );

      if (!teamsPlayed) return;

      if (winner === teamAId) {
        teamAWins += 1;
      }

      if (winner === teamBId) {
        teamBWins += 1;
      }
    });

    return teamAWins - teamBWins;
  }

  function compareTeams(teamA, teamB) {
    const statsA =
      getTeamStats(teamA.id);

    const statsB =
      getTeamStats(teamB.id);

    if (
      statsB.winPct !==
      statsA.winPct
    ) {
      return (
        statsB.winPct -
        statsA.winPct
      );
    }

    const headToHead =
      getHeadToHeadResult(
        teamA.id,
        teamB.id
      );

    if (headToHead !== 0) {
      return -headToHead;
    }

    if (
      teamA.division ===
      teamB.division
    ) {
      if (
        statsB.divisionPct !==
        statsA.divisionPct
      ) {
        return (
          statsB.divisionPct -
          statsA.divisionPct
        );
      }
    }

    if (
      teamA.conference ===
      teamB.conference
    ) {
      if (
        statsB.conferencePct !==
        statsA.conferencePct
      ) {
        return (
          statsB.conferencePct -
          statsA.conferencePct
        );
      }
    }

    if (
      statsB.wins !== statsA.wins
    ) {
      return (
        statsB.wins -
        statsA.wins
      );
    }

    if (
      statsA.losses !==
      statsB.losses
    ) {
      return (
        statsA.losses -
        statsB.losses
      );
    }

    return teamA.name.localeCompare(
      teamB.name
    );
  }

  function getDivisionStandings() {
    const divisions = [
      ...new Set(
        teams.map(
          (team) => team.division
        )
      ),
    ];

    return divisions.map(
      (division) => {
        const divisionTeams = teams
          .filter(
            (team) =>
              team.division ===
              division
          )
          .sort(compareTeams);

        return {
          division,
          teams: divisionTeams,
        };
      }
    );
  }

  function getConferenceStandings(
    conference
  ) {
    return teams
      .filter(
        (team) =>
          team.conference ===
          conference
      )
      .sort(compareTeams);
  }

  // NEW: Request 10 seeds to include the three teams
  // directly outside the playoff field.
  function getPlayoffPicture(
    conference,
    maximumSeeds = 7
  ) {
    const conferenceTeams =
      teams.filter(
        (team) =>
          team.conference ===
          conference
      );

    const divisions = [
      ...new Set(
        conferenceTeams.map(
          (team) => team.division
        )
      ),
    ];

    const divisionWinners = divisions
      .map((division) =>
        conferenceTeams
          .filter(
            (team) =>
              team.division ===
              division
          )
          .sort(compareTeams)[0]
      )
      .sort(compareTeams);

    const wildCardTeams =
      conferenceTeams
        .filter(
          (team) =>
            !divisionWinners.some(
              (winner) =>
                winner.id === team.id
            )
        )
        .sort(compareTeams);

    return [
      ...divisionWinners,
      ...wildCardTeams,
    ].slice(0, maximumSeeds);
  }

  function getOverallStandings() {
    return [...teams].sort(
      compareTeams
    );
  }

  function getTeamStandingData(team) {
    const stats =
      getTeamStats(team.id);

    const progress =
      getTeamPickProgress(team.id);

    return {
      ...team,
      ...stats,
      pickedGames:
        progress.picked,
      totalGames:
        progress.total,
    };
  }

  // Visual components
  function renderTeamLogo(
    team,
    className = "team-logo-img"
  ) {
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

  // NEW: Highlight only actual final winners.
  function renderPickButtons(game) {
    const awayTeam =
      getTeamById(game.awayTeam);

    const homeTeam =
      getTeamById(game.homeTeam);

    const selectedPick =
      picks[game.id];

    const actualWinner =
      getActualWinner(game);

    const disabled =
      isGameStarted(game) ||
      !picksEditable;

    const buttonClass = (teamId) =>
      [
        "pick-button",
        selectedPick === teamId
          ? "selected"
          : "",
        actualWinner === teamId
          ? "result-winner"
          : "",
      ]
        .filter(Boolean)
        .join(" ");

    return (
      <div className="matchup">
        <button
          className={buttonClass(
            awayTeam.id
          )}
          aria-label={`${awayTeam.name}${
            actualWinner === awayTeam.id
              ? ", actual winner"
              : ""
          }`}
          disabled={disabled}
          onClick={() =>
            handlePick(
              game.id,
              awayTeam.id
            )
          }
        >
          {renderTeamLogo(
            awayTeam,
            "small-logo-img"
          )}
          {awayTeam.name}
        </button>

        <span className="at-symbol">
          {game.neutralSite
            ? "vs"
            : "@"}
        </span>

        <button
          className={buttonClass(
            homeTeam.id
          )}
          aria-label={`${homeTeam.name}${
            actualWinner === homeTeam.id
              ? ", actual winner"
              : ""
          }`}
          disabled={disabled}
          onClick={() =>
            handlePick(
              game.id,
              homeTeam.id
            )
          }
        >
          {renderTeamLogo(
            homeTeam,
            "small-logo-img"
          )}
          {homeTeam.name}
        </button>

        <button
          className={
            selectedPick === TIE_PICK
              ? "pick-button selected tie-pick-button"
              : "pick-button tie-pick-button"
          }
          disabled={disabled}
          onClick={() =>
            handlePick(
              game.id,
              TIE_PICK
            )
          }
        >
          Predict Tie
        </button>
      </div>
    );
  }

  function renderLiveScore(game) {
    const live = getLiveGame(game);

    if (!live) return null;

    const scoreVisible =
      live.state !== "pre" &&
      Number.isFinite(
        live.awayScore
      ) &&
      Number.isFinite(
        live.homeScore
      );

    const label =
      live.state === "post"
        ? "Final"
        : live.state === "in"
        ? "Live"
        : "Scheduled";

    const detail = String(
      live.detail || ""
    );

    const redundantFinal =
      live.state === "post" &&
      /^final(?:\b|\/)/i.test(
        detail
      );

    const statusText =
      detail && !redundantFinal
        ? `${label} · ${detail}`
        : detail.match(/OT/i)
        ? `${label} · OT`
        : label;

    return (
      <div
        className={`live-score-strip status-${live.state}`}
      >
        <span className="score-status">
          {statusText}
        </span>

        {scoreVisible && (
          <strong>
            {live.awayTeam}{" "}
            {live.awayScore} —{" "}
            {live.homeScore}{" "}
            {live.homeTeam}
          </strong>
        )}
      </div>
    );
  }

  function renderPickedText(game) {
    const selectedPick =
      picks[game.id];

    const verdict =
      getPickEvaluation(game);

    const selectedTeamName =
      selectedPick === TIE_PICK
        ? "Tie"
        : getTeamById(
            selectedPick
          )?.name;

    const verdictLabels = {
      correct: "Correct ✓",
      wrong: "Incorrect ✕",
      push: "Tie / Push",
      pending: "Pending",
    };

    return (
      <p className="picked-text">
        Pick:{" "}
        {selectedPick
          ? selectedTeamName
          : "No pick yet"}

        {verdict && (
          <span
            className={`pick-verdict verdict-${verdict}`}
          >
            {" "}·{" "}
            {verdictLabels[verdict]}
          </span>
        )}

        {isGameStarted(game) && (
          <span className="locked-note">
            {" "}· Pick locked
          </span>
        )}
      </p>
    );
  }

  function renderScoreControls() {
    return (
      <div className="score-controls">
        <span className="score-health">
          {scoreError
            ? scoreError
            : scoreSourceReady
            ? "Score feed connected · auto-refreshes every 2 min live / 10 min otherwise"
            : "Connecting to scores…"}

          {scoreCache.updatedAt &&
            ` · Last checked ${new Date(
              scoreCache.updatedAt
            ).toLocaleTimeString(
              [],
              {
                hour: "numeric",
                minute: "2-digit",
              }
            )}`}
        </span>

        <button
          className="score-refresh-button"
          onClick={refreshScores}
          disabled={scoreLoading}
        >
          {scoreLoading
            ? "Loading…"
            : "Refresh Scores"}
        </button>
      </div>
    );
  }

  function renderDashboard() {
    const afcOneSeed =
      afcPlayoffPicture[0];

    const nfcOneSeed =
      nfcPlayoffPicture[0];

    const topProjectedTeams =
      overallStandings.slice(0, 5);

    return (
      <>
        <div className="dashboard-hero">
          <div>
            <h2>
              Season Dashboard
            </h2>
            <p>
              Live NFL results, your picks,
              projected standings and playoff outlook.
            </p>
          </div>

          <button
            className="primary-action-button"
            onClick={() =>
              setActiveTab("picks")
            }
          >
            Make Picks
          </button>
        </div>

        {renderScoreControls()}

        <div className="dashboard-grid">
          <div className="dashboard-card">
            <span>Total Picks</span>
            <strong>
              {totalPickedGames}/
              {totalGames}
            </strong>
            <p>
              {totalGames -
                totalPickedGames}{" "}
              games remaining
            </p>
          </div>

          <div className="dashboard-card">
            <span>
              Completed Weeks
            </span>
            <strong>
              {completedWeeks}/
              {availableWeeks.length}
            </strong>
            <p>
              {availableWeeks.length -
                completedWeeks}{" "}
              weeks still open
            </p>
          </div>

          <div className="dashboard-card">
            <span>
              Selected Team
            </span>
            <strong>
              {selectedTeam.name}
            </strong>
            <p>
              Actual + projected:{" "}
              {recordText(
                selectedTeamProjectedRecord
              )}
            </p>
          </div>

          <div className="dashboard-card">
            <span>
              Current 1 Seeds
            </span>
            <strong>
              {afcOneSeed
                ? afcOneSeed.name
                : "AFC TBD"}{" "}
              /{" "}
              {nfcOneSeed
                ? nfcOneSeed.name
                : "NFC TBD"}
            </strong>
            <p>
              Final results + picks for
              unplayed games
            </p>
          </div>
        </div>

        <div className="dashboard-grid result-summary-grid">
          <div className="dashboard-card">
            <span>
              Correct Picks
            </span>
            <strong>
              {scoreCounts.correct}
            </strong>
          </div>

          <div className="dashboard-card">
            <span>
              Incorrect Picks
            </span>
            <strong>
              {scoreCounts.wrong}
            </strong>
          </div>

          <div className="dashboard-card">
            <span>
              Tie / Push
            </span>
            <strong>
              {scoreCounts.push}
            </strong>
          </div>

          <div className="dashboard-card">
            <span>
              Pending Picks
            </span>
            <strong>
              {scoreCounts.pending}
            </strong>
          </div>
        </div>

        <div className="dashboard-two-column">
          <div className="dashboard-panel">
            <h2>
              Season Outlook
              (Results + Predictions)
            </h2>

            {topProjectedTeams.map(
              (team, index) => {
                const data =
                  getTeamStandingData(
                    team
                  );

                return (
                  <button
                    className="dashboard-team-row"
                    key={team.id}
                    onClick={() => {
                      setSelectedTeamId(
                        team.id
                      );
                      setActiveTab(
                        "team"
                      );
                    }}
                  >
                    <span>
                      #{index + 1}
                    </span>

                    <span>
                      {renderTeamLogo(
                        team,
                        "small-logo-img"
                      )}
                    </span>

                    <span>
                      {team.name}
                    </span>

                    <strong>
                      {recordText(
                        data
                      )}
                    </strong>
                  </button>
                );
              }
            )}
          </div>

          <div className="dashboard-panel contest-preview-panel">
            <h2>My Account</h2>

            <p>
              {session
                ? `Signed in as ${
                    profile?.display_name ||
                    session.user.email
                  }`
                : "Playing as a guest — create an account to save picks across devices."}
            </p>

            <div className="contest-preview-list">
              <span>
                Pick storage:{" "}
                {session
                  ? cloudReady
                    ? "Saved to cloud"
                    : "Loading cloud picks"
                  : "This browser only"}
              </span>

              <span>
                Favorite team:{" "}
                {profile?.favorite_team
                  ? getTeamById(
                      profile.favorite_team
                    )?.name
                  : "Not set"}
              </span>

              <span>
                Coming later:
                group contests and leaderboards
              </span>
            </div>

            <button
              className="account-secondary-button"
              onClick={() =>
                setActiveTab("account")
              }
            >
              {session
                ? "Manage Account"
                : "Sign Up / Sign In"}
            </button>
          </div>
        </div>

        {renderWeekCompletionTracker()}
      </>
    );
  }

  // NEW: Finished weeks turn green automatically.
  function renderWeekCompletionTracker() {
    return (
      <div className="week-completion-card">
        <div className="week-completion-header">
          <h2>
            Week Completion
          </h2>

          <p>
            Overall:{" "}
            {totalPickedGames} /{" "}
            {totalGames} games picked
          </p>
        </div>

        <div className="week-completion-grid">
          {availableWeeks.map(
            (week) => {
              const progress =
                getWeekPickProgress(
                  week
                );

              const classes = [
                "week-completion-button",
                progress.isComplete
                  ? "complete"
                  : progress.status ===
                    "In Progress"
                  ? "in-progress"
                  : "",
                progress.allGamesFinal
                  ? "results-final"
                  : "",
                selectedWeek === week
                  ? "active"
                  : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={week}
                  className={classes}
                  onClick={() => {
                    setSelectedWeek(
                      week
                    );
                    setActiveTab(
                      "picks"
                    );
                  }}
                >
                  <span>
                    Week {week}
                  </span>

                  <strong>
                    {progress.picked}/
                    {progress.total} picks
                    {progress.isComplete
                      ? " ✅"
                      : ""}
                  </strong>

                  <small>
                    {progress.status}
                  </small>
                </button>
              );
            }
          )}
        </div>
      </div>
    );
  }

  function renderMyPicks() {
    const pickedGames =
      schedule2026.filter(
        (game) =>
          picks[game.id]
      );

    const filtered =
      myPicksWeekFilter === "all"
        ? pickedGames
        : pickedGames.filter(
            (game) =>
              game.week ===
              Number(
                myPicksWeekFilter
              )
          );

    const weeks = [
      ...new Set(
        filtered.map(
          (game) => game.week
        )
      ),
    ];

    return (
      <>
        <div className="my-picks-controls">
          <label htmlFor="my-picks-week-filter">
            Filter by week:
          </label>

          <select
            id="my-picks-week-filter"
            value={myPicksWeekFilter}
            onChange={(event) =>
              setMyPicksWeekFilter(
                event.target.value
              )
            }
          >
            <option value="all">
              All Weeks
            </option>

            {availableWeeks.map(
              (week) => (
                <option
                  key={week}
                  value={week}
                >
                  Week {week}
                </option>
              )
            )}
          </select>
        </div>

        {!filtered.length ? (
          <div className="summary-card">
            <p>
              {pickedGames.length
                ? "No picks for this week."
                : "You have not made any picks yet."}
            </p>
          </div>
        ) : (
          <div className="my-picks-list">
            {weeks.map((week) => (
              <div
                className="my-picks-week"
                key={week}
              >
                <h2>
                  Week {week}
                </h2>

                {filtered
                  .filter(
                    (game) =>
                      game.week ===
                      week
                  )
                  .map((game) => {
                    const away =
                      getTeamById(
                        game.awayTeam
                      );

                    const home =
                      getTeamById(
                        game.homeTeam
                      );

                    const choice =
                      picks[game.id];

                    const pickName =
                      choice ===
                      TIE_PICK
                        ? "Tie"
                        : getTeamById(
                            choice
                          )?.name;

                    const verdict =
                      getPickEvaluation(
                        game
                      );

                    const labels = {
                      correct:
                        "Correct",
                      wrong:
                        "Incorrect",
                      push:
                        "Tie / Push",
                      pending:
                        "Pending",
                    };

                    return (
                      <div
                        className="my-pick-row"
                        key={game.id}
                      >
                        <div>
                          <strong>
                            {renderTeamLogo(
                              away,
                              "small-logo-img"
                            )}{" "}
                            {away.name}{" "}
                            {game.neutralSite
                              ? "vs"
                              : "@"}{" "}
                            {renderTeamLogo(
                              home,
                              "small-logo-img"
                            )}{" "}
                            {home.name}
                          </strong>

                          <p>
                            Week{" "}
                            {game.week}{" "}
                            ·{" "}
                            {game.date}{" "}
                            ·{" "}
                            {game.time}
                          </p>

                          {renderLiveScore(
                            game
                          )}
                        </div>

                        <div className="my-pick-winner">
                          Pick:{" "}
                          {pickName}

                          <span
                            className={`pick-verdict verdict-${verdict}`}
                          >
                            {" "}·{" "}
                            {
                              labels[
                                verdict
                              ]
                            }
                          </span>
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

        <p className="account-muted">
          {session
            ? cloudBusy
              ? "Saving picks to cloud…"
              : cloudReady
              ? "Signed in · Cloud picks"
              : "Loading cloud picks…"
            : "Guest picks · Saved on this device"}
        </p>

        <p>
          Total Games Picked:{" "}
          {totalPickedGames} /{" "}
          {totalGames}
        </p>

        <p>
          Week {selectedWeek} Picks:{" "}
          {selectedWeekPickedGames} /{" "}
          {
            selectedWeekGames.length
          }
        </p>

        <p>
          Correct:{" "}
          {scoreCounts.correct} ·
          Incorrect:{" "}
          {scoreCounts.wrong} ·
          Pushes:{" "}
          {scoreCounts.push}
        </p>
      </div>
    );
  }

  function renderTeamSelectorAndCard() {
    return (
      <div className="top-section">
        <div>
          <div className="dropdown-section">
            <label htmlFor="team-select">
              Choose a team:{" "}
            </label>

            <select
              id="team-select"
              value={selectedTeamId}
              onChange={(event) =>
                setSelectedTeamId(
                  event.target.value
                )
              }
            >
              {teams.map(
                (team) => (
                  <option
                    key={team.id}
                    value={team.id}
                  >
                    {team.name}
                  </option>
                )
              )}
            </select>
          </div>

          <div
            className="showcase-card"
            style={{
              borderColor:
                selectedTeam.primaryColor,
            }}
          >
            <div className="showcase-logo">
              {renderTeamLogo(
                selectedTeam,
                "showcase-logo-img"
              )}
            </div>

            <h2>
              {selectedTeam.name}
            </h2>

            <p>
              {selectedTeam.conference}{" "}
              {selectedTeam.division}
            </p>

            <p>
              Season Outlook:{" "}
              {recordText(
                selectedTeamProjectedRecord
              )}
            </p>

            <p>
              Games Picked:{" "}
              {selectedTeamPickProgress.picked}{" "}
              /{" "}
              {selectedTeamPickProgress.total}
            </p>

            <p>
              Remaining:{" "}
              {selectedTeamPickProgress.remaining}
            </p>
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
          <h2>
            Week {selectedWeek} Picks
          </h2>

          <select
            value={selectedWeek}
            onChange={(event) =>
              setSelectedWeek(
                Number(
                  event.target.value
                )
              )
            }
          >
            {availableWeeks.map(
              (week) => (
                <option
                  key={week}
                  value={week}
                >
                  Week {week}
                </option>
              )
            )}
          </select>

          <div className="week-action-buttons">
            <button
              className="sim-button"
              disabled={!picksEditable}
              onClick={() =>
                simulateRemaining(
                  "week"
                )
              }
            >
              Sim Remaining Week{" "}
              {selectedWeek}
            </button>

            <button
              className="clear-button"
              disabled={!picksEditable}
              onClick={
                clearSelectedWeekPicks
              }
            >
              Clear Week{" "}
              {selectedWeek}
            </button>

            <button
              className="sim-button"
              disabled={!picksEditable}
              onClick={() =>
                simulateRemaining(
                  "season"
                )
              }
            >
              Sim Rest of Season
            </button>

            <button
              className="clear-button danger"
              disabled={!picksEditable}
              onClick={clearPicks}
            >
              Clear Unlocked Picks
            </button>
          </div>
        </div>

        <p className="game-details">
          Simulator preserves manual picks and skips
          games that already started. Picks lock
          at kickoff.
        </p>

        {renderScoreControls()}

        <div className="pick-list">
          {selectedWeekGames.map(
            (game) => (
              <div
                className="pick-game-card"
                key={game.id}
              >
                <div>
                  <strong>
                    Week {game.week}
                  </strong>

                  <p>
                    {game.date} -{" "}
                    {game.time}
                  </p>

                  <p className="game-details">
                    {game.network}
                    {game.neutralSite &&
                    game.location
                      ? ` · ${game.location}`
                      : ""}
                  </p>
                </div>

                {renderLiveScore(
                  game
                )}

                {renderPickButtons(
                  game
                )}

                {renderPickedText(
                  game
                )}
              </div>
            )
          )}
        </div>
      </section>
    );
  }

  function renderSelectedTeamSchedule() {
    return (
      <section className="picks-column">
        <h2>
          {selectedTeam.name} Schedule Picks
        </h2>

        <div className="team-schedule-pick-list">
          {selectedTeamSchedule.map(
            (game) => (
              <div
                className="pick-game-card"
                key={game.id}
              >
                <div>
                  <strong>
                    Week {game.week}
                  </strong>

                  <p>
                    {game.date} -{" "}
                    {game.time}
                  </p>

                  <p className="game-details">
                    {game.network}
                    {game.neutralSite &&
                    game.location
                      ? ` · ${game.location}`
                      : ""}
                  </p>
                </div>

                {renderLiveScore(
                  game
                )}

                {renderPickButtons(
                  game
                )}

                {renderPickedText(
                  game
                )}
              </div>
            )
          )}
        </div>
      </section>
    );
  }

  // Reusable standings table.
  function renderStandingsTable(
    title,
    standings,
    rankLabel = "Rank",
    recordType = "conference",
    startRank = 1
  ) {
    return (
      <div className="standings-table">
        {title && (
          <div className="standings-title">
            {title}
          </div>
        )}

        <div className="standings-header">
          <span>
            {rankLabel}
          </span>
          <span>Team</span>
          <span>Record</span>
          <span>
            {recordType ===
            "division"
              ? "Div"
              : "Conf"}
          </span>
        </div>

        {standings.map(
          (team, index) => {
            const data =
              getTeamStandingData(
                team
              );

            return (
              <div
                className="standings-row"
                key={team.id}
              >
                <span>
                  #{index + startRank}
                </span>

                <span
                  className="standings-team"
                  onClick={() => {
                    setSelectedTeamId(
                      team.id
                    );
                    setActiveTab(
                      "team"
                    );
                  }}
                >
                  <span>
                    {renderTeamLogo(
                      team,
                      "small-logo-img"
                    )}
                  </span>
                  <span>
                    {team.name}
                  </span>
                </span>

                <span>
                  {recordText(
                    data
                  )}
                </span>

                <span>
                  {recordType ===
                  "division"
                    ? `${data.divisionWins}-${data.divisionLosses}-${data.divisionTies}`
                    : `${data.conferenceWins}-${data.conferenceLosses}-${data.conferenceTies}`}
                </span>
              </div>
            );
          }
        )}
      </div>
    );
  }

  function renderTeamsGrid() {
    return (
      <>
        <h2>Teams</h2>

        <div className="team-grid">
          {teams.map(
            (team) => {
              const teamProjectedRecord =
                getProjectedRecord(
                  team.id
                );

              return (
                <div
                  className="team-card"
                  key={team.id}
                  onClick={() => {
                    setSelectedTeamId(
                      team.id
                    );
                    setActiveTab(
                      "team"
                    );
                  }}
                >
                  <div className="team-logo">
                    {renderTeamLogo(
                      team,
                      "team-logo-img"
                    )}
                  </div>

                  <h3>
                    {team.name}
                  </h3>

                  <p>
                    {team.conference}{" "}
                    {team.division}
                  </p>

                  <p>
                    Season Outlook:{" "}
                    {recordText(
                      teamProjectedRecord
                    )}
                  </p>
                </div>
              );
            }
          )}
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <h1>NFL Pick'em App</h1>

      <p>
        Pick winners for the 2026-27 NFL season.
      </p>

      <div className="tab-nav">
        <button
          className={
            activeTab === "dashboard"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("dashboard")
          }
        >
          Dashboard
        </button>

        <button
          className={
            activeTab === "picks"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("picks")
          }
        >
          Picks
        </button>

        <button
          className={
            activeTab === "myPicks"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("myPicks")
          }
        >
          My Picks
        </button>

        <button
          className={
            activeTab === "team"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("team")
          }
        >
          Team View
        </button>

        <button
          className={
            activeTab === "standings"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("standings")
          }
        >
          Standings
        </button>

        <button
          className={
            activeTab === "playoffs"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("playoffs")
          }
        >
          Playoffs
        </button>

        <button
          className={
            activeTab === "teams"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("teams")
          }
        >
          Teams
        </button>

        <button
          className={
            activeTab === "account"
              ? "tab-button active"
              : "tab-button"
          }
          onClick={() =>
            setActiveTab("account")
          }
        >
          {session
            ? "My Account"
            : "Sign In"}
        </button>
      </div>

      {session && (
        <div
          className="cloud-banner"
          role="status"
        >
          {cloudBusy
            ? "Saving cloud picks…"
            : !cloudReady
            ? "Loading cloud picks…"
            : `Signed in as ${
                profile?.display_name ||
                session.user.email
              } · Cloud picks ready`}

          {cloudError && (
            <span className="account-error">
              {" "}
              {cloudError}
            </span>
          )}
        </div>
      )}

      {activeTab === "dashboard" &&
        renderDashboard()}

      {activeTab === "picks" && (
        <>
          {renderPickSummary()}
          {renderWeekCompletionTracker()}

          <div className="single-column-section">
            {renderWeekPicks()}
          </div>
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
          <h2>
            Division Standings
            (Final Results + Remaining Picks)
          </h2>

          <div className="division-standings-grid">
            {divisionStandings.map(
              (divisionGroup) => (
                <div
                  className="standings-table"
                  key={divisionGroup.division}
                >
                  <div className="standings-title">
                    {divisionGroup.division}
                  </div>

                  <div className="standings-header">
                    <span>Rank</span>
                    <span>Team</span>
                    <span>Record</span>
                    <span>Div</span>
                  </div>

                  {divisionGroup.teams.map(
                    (team, index) => {
                      const data =
                        getTeamStandingData(
                          team
                        );

                      return (
                        <div
                          className="standings-row"
                          key={team.id}
                        >
                          <span>
                            #{index + 1}
                          </span>

                          <span
                            className="standings-team"
                            onClick={() => {
                              setSelectedTeamId(
                                team.id
                              );
                              setActiveTab(
                                "team"
                              );
                            }}
                          >
                            <span>
                              {renderTeamLogo(
                                team,
                                "small-logo-img"
                              )}
                            </span>
                            <span>
                              {team.name}
                            </span>
                          </span>

                          <span>
                            {recordText(data)}
                          </span>

                          <span>
                            {data.divisionWins}-
                            {data.divisionLosses}-
                            {data.divisionTies}
                          </span>
                        </div>
                      );
                    }
                  )}
                </div>
              )
            )}
          </div>

          <h2>AFC Standings</h2>
          {renderStandingsTable(
            "",
            afcStandings
          )}

          <h2>NFC Standings</h2>
          {renderStandingsTable(
            "",
            nfcStandings
          )}
        </>
      )}

      {activeTab === "playoffs" && (
        <>
          <h2>
            Projected Playoff Picture
            (Final Results + Remaining Picks)
          </h2>

          <p className="game-details playoff-explainer">
            Seeds #1–#4 are projected division winners;
            #5–#7 are wild cards. In the Hunt lists the
            next three teams (#8–#10) outside the
            projected playoff field.
          </p>

          <div className="playoff-picture">
            <div className="playoff-conference-group">
              {renderStandingsTable(
                "AFC Playoff Seeds",
                afcPlayoffPicture,
                "Seed"
              )}

              {renderStandingsTable(
                "AFC In the Hunt · First Three Out",
                afcInTheHunt,
                "Rank",
                "conference",
                8
              )}
            </div>

            <div className="playoff-conference-group">
              {renderStandingsTable(
                "NFC Playoff Seeds",
                nfcPlayoffPicture,
                "Seed"
              )}

              {renderStandingsTable(
                "NFC In the Hunt · First Three Out",
                nfcInTheHunt,
                "Rank",
                "conference",
                8
              )}
            </div>
          </div>
        </>
      )}

      {activeTab === "teams" &&
        renderTeamsGrid()}

      {activeTab === "account" &&
        renderAccount()}
    </div>
  );
}

export default App;
