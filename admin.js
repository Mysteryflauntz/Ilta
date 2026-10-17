const config = window.ILTA_SUPABASE_CONFIG;
const loginPanel = document.querySelector("#login-panel");
const dashboardPanel = document.querySelector("#dashboard-panel");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");

let client;
let refreshTimer;
let realtimeChannel;
let activeAdminId;

function setMessage(message, isError = false) {
  loginMessage.textContent = message;
  loginMessage.classList.toggle("error", isError);
}

function setDashboardVisible(visible) {
  loginPanel.hidden = visible;
  dashboardPanel.hidden = !visible;
}

function showConfigurationError(message) {
  loginForm.hidden = true;
  setMessage(message, true);
}

async function createSupabaseClient() {
  if (!config?.url || !config?.anonKey) {
    showConfigurationError("Supabase is not configured yet. Add the project URL and public anon key in supabase-config.js.");
    return false;
  }
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    client = createClient(config.url, config.anonKey);
    return true;
  } catch (error) {
    console.error("Unable to load the Supabase client:", error);
    showConfigurationError("Could not connect to the Supabase client library. Check your network and try again.");
    return false;
  }
}

async function isAdmin(userId) {
  const { data, error } = await client.from("ilta_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function loadMetrics() {
  const now = Date.now();
  const activeSince = new Date(now - 5 * 60 * 1000).toISOString();
  const monthSince = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [active, sessions, clicks] = await Promise.all([
    client.from("ilta_sessions").select("session_id", { count: "exact", head: true }).gte("last_seen", activeSince),
    client.from("ilta_sessions").select("session_id", { count: "exact", head: true }).gte("created_at", monthSince),
    client.from("ilta_clicks").select("id", { count: "exact", head: true }).gte("clicked_at", monthSince),
  ]);
  const failed = [active, sessions, clicks].find((result) => result.error);
  if (failed) throw failed.error;
  document.querySelector("#active-count").textContent = active.count ?? "0";
  document.querySelector("#session-count").textContent = sessions.count ?? "0";
  document.querySelector("#click-count").textContent = clicks.count ?? "0";

  const { data, error } = await client.from("ilta_clicks")
    .select("destination,event_id,event_name,clicked_at")
    .gte("clicked_at", monthSince)
    .order("clicked_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  renderClicks(data || []);
  document.querySelector("#analytics-updated").textContent = `Updated ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
}

function renderClicks(clicks) {
  const list = document.querySelector("#click-list");
  if (!clicks.length) {
    const empty = document.createElement("p");
    empty.className = "click-empty";
    empty.textContent = "No tracked outbound clicks yet.";
    list.replaceChildren(empty);
    return;
  }
  const rows = clicks.map((click) => {
    const row = document.createElement("div");
    row.className = "click-row";
    const main = document.createElement("div");
    const title = document.createElement("b");
    title.textContent = click.event_name || "External data source";
    const detail = document.createElement("span");
    detail.textContent = `${click.destination} · ${click.event_id || "Ilta source link"}`;
    main.append(title, detail);
    const time = document.createElement("time");
    time.dateTime = click.clicked_at;
    time.textContent = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(click.clicked_at));
    row.append(main, time);
    return row;
  });
  list.replaceChildren(...rows);
}

function subscribeToChanges() {
  realtimeChannel = client.channel("ilta-admin-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "ilta_sessions" }, scheduleRefresh)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ilta_clicks" }, scheduleRefresh)
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        document.querySelector("#analytics-updated").textContent = "Live updates unavailable; retrying";
        console.error("Ilta admin realtime subscription status:", status);
      }
    });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    loadMetrics().catch((error) => {
      console.error("Unable to refresh Ilta admin analytics:", error);
      document.querySelector("#analytics-updated").textContent = "Could not refresh analytics";
    });
  }, 250);
}

async function enterDashboard(user) {
  if (activeAdminId === user.id && realtimeChannel) return;
  if (!await isAdmin(user.id)) {
    await client.auth.signOut();
    setDashboardVisible(false);
    setMessage("This account does not have Ilta administrator access.", true);
    return;
  }
  if (realtimeChannel) client.removeChannel(realtimeChannel);
  activeAdminId = user.id;
  setDashboardVisible(true);
  try {
    await loadMetrics();
  } catch (error) {
    console.error("Unable to load Ilta admin analytics:", error);
    document.querySelector("#analytics-updated").textContent = "Could not load analytics";
  }
  subscribeToChanges();
}

async function initialize() {
  if (!await createSupabaseClient()) return;

  const { data, error } = await client.auth.getSession();
  if (error) {
    console.error("Unable to read Supabase auth session:", error);
    setMessage("Unable to check your sign-in. Please reload and try again.", true);
  } else if (data.session) {
    try {
      await enterDashboard(data.session.user);
    } catch (authError) {
      console.error("Unable to verify administrator access:", authError);
      setMessage("Unable to verify administrator access. Please try again.", true);
    }
  }

  client.auth.onAuthStateChange((_event, session) => {
    if (session) {
      window.setTimeout(() => enterDashboard(session.user).catch((error) => {
        console.error("Unable to open Ilta admin dashboard:", error);
        setMessage("Unable to open the dashboard. Please try again.", true);
      }), 0);
    } else {
      if (realtimeChannel) client.removeChannel(realtimeChannel);
      realtimeChannel = null;
      activeAdminId = null;
      setDashboardVisible(false);
    }
  });
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!client) return;
  const form = new FormData(loginForm);
  const email = String(form.get("email") || "");
  const password = String(form.get("password") || "");
  const submit = loginForm.querySelector("button[type=submit]");
  submit.disabled = true;
  setMessage("Signing in…");
  try {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("Ilta admin sign-in failed:", error);
      setMessage("Sign-in failed. Check your email and password.", true);
      return;
    }
  } catch (error) {
    console.error("Ilta admin sign-in could not reach Supabase:", error);
    setMessage("Sign-in failed. Check your email and password.", true);
  } finally {
    submit.disabled = false;
  }
  if (!loginMessage.classList.contains("error")) setMessage("Signed in. Checking administrator access…");
});

document.querySelector("#sign-out").addEventListener("click", async () => {
  const { error } = await client.auth.signOut();
  if (error) {
    console.error("Ilta admin sign-out failed:", error);
    document.querySelector("#analytics-updated").textContent = "Sign out failed";
  }
});

initialize();
