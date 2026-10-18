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

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function addReviewField(form, labelText, name, value = "", type = "text", required = false, wide = false) {
  const label = document.createElement("label");
  if (wide) label.classList.add("review-wide");
  label.append(document.createTextNode(labelText));
  const input = type === "textarea" ? document.createElement("textarea") : document.createElement("input");
  if (type !== "textarea") input.type = type;
  input.name = name;
  input.value = value || "";
  input.required = required;
  if (type === "url") input.placeholder = "https://";
  label.append(input);
  form.append(label);
}

function setReviewStatus(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error", isError);
}

function createReviewCard(record, kind) {
  const social = kind === "social";
  const card = document.createElement("article");
  card.className = "review-card";
  const summary = document.createElement("div");
  summary.className = "review-card-summary";
  const heading = document.createElement("b");
  heading.textContent = social ? `${record.source_name} · ${record.provider}` : record.title;
  const body = document.createElement("p");
  body.textContent = social ? record.post_text || "No post caption provided." : `${record.organizer_name} · ${new Date(record.starts_at).toLocaleString()}`;
  const sourceUrl = social ? record.post_url : record.event_url;
  const sourceLink = document.createElement("a");
  sourceLink.href = sourceUrl;
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.textContent = social ? "Open original social post ↗" : "Open submitted event page ↗";
  summary.append(heading, body, sourceLink);

  const form = document.createElement("form");
  form.className = "review-card-form";
  const defaults = social
    ? {
      title: (record.post_text || "").split(/\r?\n/)[0].slice(0, 200),
      organizer_name: record.source_name,
      starts_at: "",
      venue: "",
      address: "",
      event_url: record.post_url,
      image_url: record.image_url,
      image_alt: record.image_url ? `Artwork from ${record.source_name}'s social post` : "",
      is_free: false,
      price: "",
      description: record.post_text,
    }
    : {
      title: record.title,
      organizer_name: record.organizer_name,
      starts_at: localDateTimeValue(record.starts_at),
      venue: record.venue,
      address: record.address,
      event_url: record.event_url,
      image_url: record.image_url,
      image_alt: record.image_alt,
      is_free: record.is_free,
      price: record.price,
      description: record.description,
    };
  addReviewField(form, "Event name", "title", defaults.title, "text", true);
  addReviewField(form, "Organiser", "organizer_name", defaults.organizer_name, "text", true);
  addReviewField(form, "Date and time", "starts_at", defaults.starts_at, "datetime-local", true);
  addReviewField(form, "Venue", "venue", defaults.venue, "text", true);
  addReviewField(form, "Address", "address", defaults.address);
  addReviewField(form, "Official event or ticket URL", "event_url", defaults.event_url, "url", true, true);
  addReviewField(form, "Flyer image URL", "image_url", defaults.image_url, "url", false, true);
  addReviewField(form, "Image description", "image_alt", defaults.image_alt, "text", false, true);
  const freeLabel = document.createElement("label");
  freeLabel.className = "review-free";
  const freeInput = document.createElement("input");
  freeInput.type = "checkbox";
  freeInput.name = "is_free";
  freeInput.checked = defaults.is_free;
  freeLabel.append(freeInput, document.createTextNode("Free entry"));
  form.append(freeLabel);
  addReviewField(form, "Entry price (required unless free)", "price", defaults.price);
  addReviewField(form, "Verified event details", "description", defaults.description, "textarea", false, true);

  const actions = document.createElement("div");
  actions.className = "review-card-form-actions";
  const publish = document.createElement("button");
  publish.className = "button button-lime";
  publish.type = "submit";
  publish.textContent = "Verify & publish";
  const reject = document.createElement("button");
  reject.className = "button button-outline";
  reject.type = "button";
  reject.textContent = "Reject";
  actions.append(publish, reject);
  const status = document.createElement("span");
  status.className = "review-card-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.append(actions, status);

  reject.addEventListener("click", async () => {
    reject.disabled = true;
    try {
      const table = social ? "ilta_social_candidates" : "ilta_submissions";
      const { error } = await client.from(table).update({ status: "rejected" }).eq("id", record.id);
      if (error) throw error;
      setReviewStatus(status, "Rejected.");
      await loadEventReviews();
    } catch (error) {
      console.error("Unable to reject Ilta event draft:", error);
      setReviewStatus(status, "Could not reject this draft. Try again.", true);
      reject.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    publish.disabled = true;
    reject.disabled = true;
    setReviewStatus(status, "Publishing verified event…");
    try {
      const values = new FormData(form);
      const eventUrl = String(values.get("event_url") || "").trim();
      const imageUrl = String(values.get("image_url") || "").trim();
      const sourceUrl = social ? record.post_url : record.event_url;
      if (!eventUrl.startsWith("https://") || (imageUrl && !imageUrl.startsWith("https://")) || !sourceUrl.startsWith("https://")) {
        throw new Error("Use secure https:// links and verify the official event page.");
      }
      const startsAt = new Date(String(values.get("starts_at") || ""));
      if (!Number.isFinite(startsAt.getTime())) throw new Error("Enter a valid event date and time.");
      const isFree = values.get("is_free") === "on";
      const price = String(values.get("price") || "").trim();
      if (!isFree && !price) throw new Error("Enter the confirmed entry price, or mark the event as free.");
      const row = {
        title: String(values.get("title") || "").trim(),
        description: String(values.get("description") || "").trim(),
        starts_at: startsAt.toISOString(),
        venue: String(values.get("venue") || "").trim(),
        address: String(values.get("address") || "").trim(),
        is_free: isFree,
        price: isFree ? "Free" : price,
        event_url: eventUrl,
        image_url: imageUrl || null,
        image_alt: String(values.get("image_alt") || "").trim(),
        source_kind: social ? record.provider : "organizer",
        source_record_id: record.id,
        source_name: String(values.get("organizer_name") || "").trim(),
        source_url: sourceUrl,
      };
      const { error: publishError } = await client.from("ilta_events").upsert(row, {
        onConflict: "source_kind,source_record_id",
      });
      if (publishError) throw publishError;
      const table = social ? "ilta_social_candidates" : "ilta_submissions";
      const { error: updateError } = await client.from(table)
        .update({ status: social ? "used" : "published" })
        .eq("id", record.id);
      if (updateError) throw updateError;
      setReviewStatus(status, "Verified and published in Ilta.");
      await loadEventReviews();
    } catch (error) {
      console.error("Unable to publish verified Ilta event:", error);
      setReviewStatus(status, error.message || "Could not publish this event. Check the details and retry.", true);
      publish.disabled = false;
      reject.disabled = false;
    }
  });
  card.append(summary, form);
  return card;
}

async function loadEventReviews() {
  const submissionsList = document.querySelector("#submission-review-list");
  const candidatesList = document.querySelector("#social-candidate-list");
  const [submissions, candidates] = await Promise.all([
    client.from("ilta_submissions").select("*").eq("status", "pending").order("submitted_at", { ascending: false }).limit(100),
    client.from("ilta_social_candidates").select("*").eq("status", "pending").order("posted_at", { ascending: false }).limit(100),
  ]);
  if (submissions.error || candidates.error) {
    const error = submissions.error || candidates.error;
    console.error("Unable to load Ilta event review queues:", error);
    for (const list of [submissionsList, candidatesList]) {
      const message = document.createElement("p");
      message.className = "click-empty";
      message.textContent = "Could not load review items. Check the events database setup.";
      list.replaceChildren(message);
    }
    return;
  }
  const submissionRows = (submissions.data || []).map((record) => createReviewCard(record, "submission"));
  const candidateRows = (candidates.data || []).map((record) => createReviewCard(record, "social"));
  for (const [list, rows, emptyText] of [
    [submissionsList, submissionRows, "No organiser submissions waiting for review."],
    [candidatesList, candidateRows, "No imported social posts waiting for review."],
  ]) {
    if (rows.length) list.replaceChildren(...rows);
    else {
      const empty = document.createElement("p");
      empty.className = "click-empty";
      empty.textContent = emptyText;
      list.replaceChildren(empty);
    }
  }
}

async function syncSocialSources() {
  const button = document.querySelector("#sync-social-sources");
  const status = document.querySelector("#social-sync-status");
  button.disabled = true;
  status.classList.remove("error");
  status.textContent = "Checking authorised social accounts…";
  try {
    const { data, error } = await client.functions.invoke("sync-social-sources", { body: {} });
    if (error) throw error;
    const results = data.results || [];
    const detail = results.map((result) => `${result.account}: ${result.imported} new posts${result.error ? ` (${result.error})` : ""}`).join(" · ");
    status.textContent = data.message || (detail || `${data.imported || 0} new social posts imported for review.`);
    if (results.some((result) => result.error)) status.classList.add("error");
    await loadEventReviews();
  } catch (error) {
    console.error("Unable to sync authorised social accounts:", error);
    status.classList.add("error");
    status.textContent = "Social sync failed. Check API approval, token validity and server-side account configuration.";
  } finally {
    button.disabled = false;
  }
}

function subscribeToChanges() {
  realtimeChannel = client.channel("ilta-admin-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "ilta_sessions" }, scheduleRefresh)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ilta_clicks" }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "ilta_submissions" }, scheduleRefresh)
    .on("postgres_changes", { event: "*", schema: "public", table: "ilta_social_candidates" }, scheduleRefresh)
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
    Promise.all([loadMetrics(), loadEventReviews()]).catch((error) => {
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
    await loadEventReviews();
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

document.querySelector("#sync-social-sources").addEventListener("click", syncSocialSources);
document.querySelector("#refresh-submissions").addEventListener("click", () => loadEventReviews().catch((error) => {
  console.error("Unable to refresh event submissions:", error);
}));
document.querySelector("#refresh-social-candidates").addEventListener("click", () => loadEventReviews().catch((error) => {
  console.error("Unable to refresh social event drafts:", error);
}));

initialize();
