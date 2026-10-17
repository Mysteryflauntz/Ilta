const API_URL = "https://api.hel.fi/linkedevents/v1/event/?days=30&page_size=100&include=location&bbox=24.8,60.1,25.3,60.4";
const REFRESH_INTERVAL = 5 * 60 * 1000;
const SAVED_KEY = "ilta-helsinki-saved";
const CONSENT_KEY = "ilta-analytics-consent";
const HELSINKI_TZ = "Europe/Helsinki";
let analyticsClient = null;
let visitorSessionId = null;
let analyticsErrorReported = false;
const state = {
  events: [],
  nextUrl: null,
  filter: "all",
  query: "",
  view: "discover",
  saved: readSaved(),
  activeEvent: null,
  zoom: 1,
  venues: new Map(),
  lastUpdated: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
    return new Set(Array.isArray(data) ? data.filter((id) => typeof id === "string") : []);
  } catch {
    console.error("Unable to read saved Helsinki events from browser storage.");
    return new Set();
  }
}

function saveSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
  } catch (error) {
    console.error("Unable to save Helsinki events in browser storage:", error);
  }
  updateSavedCount();
}

function updateSavedCount() {
  $("#saved-count").textContent = state.saved.size;
}

function lang(value, fallback = "") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return fallback;
  return value.en || value.fi || value.sv || Object.values(value).find((item) => typeof item === "string") || fallback;
}

function plainText(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
}

function eventName(event) {
  return lang(event.name, "Untitled event");
}

function eventLocation(event) {
  return event.location || null;
}

function venueName(event) {
  const place = eventLocation(event);
  return lang(place?.name) || lang(event.location_extra_info) || "Helsinki";
}

function venueAddress(event) {
  const place = eventLocation(event);
  return lang(place?.street_address) || lang(event.location_extra_info) || "Helsinki";
}

function eventCategory(event) {
  const text = `${eventName(event)} ${plainText(lang(event.description))}`.toLowerCase();
  if (/club|night ?life|dj|dance|disco|party|yökerho|klubi|bile|tanssi|keikka|concert|live music/.test(text)) return "nightlife";
  if (/music|concert|musiik|konser|jazz|rock|band|orkester|sound|sing|song/.test(text)) return "music";
  if (/exhibition|museum|theatre|theater|art|gallery|culture|näyttely|teatter|taide|kulttuur|elokuva|film/.test(text)) return "culture";
  return "event";
}

function categoryLabel(event) {
  const category = eventCategory(event);
  return ({ nightlife: "Nightlife", music: "Music", culture: "Culture", event: "Helsinki event" })[category];
}

function eventStart(event) {
  const time = Date.parse(event.start_time || "");
  return Number.isFinite(time) ? time : 0;
}

function formatDate(event, compact = false) {
  if (!event.start_time) return "Date to be announced";
  const date = new Date(event.start_time);
  const options = compact
    ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: HELSINKI_TZ }
    : { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: HELSINKI_TZ };
  try {
    return new Intl.DateTimeFormat("en-GB", options).format(date).replace(",", " ·");
  } catch {
    return "Date to be announced";
  }
}

function eventOffer(event) {
  return Array.isArray(event.offers) ? event.offers.find((offer) => offer) : null;
}

function eventPrice(event) {
  const offer = eventOffer(event);
  if (offer?.is_free === true) return "Free";
  const price = lang(offer?.price);
  if (price) return price;
  const description = lang(offer?.description);
  if (description && !/check.*price|tarkista hinta|kontrollera pris/i.test(description)) return description;
  return offer ? "Check event page" : "Price not listed";
}

function officialUrl(event) {
  const offer = eventOffer(event);
  return lang(offer?.info_url) || lang(event.info_url) || event.external_links?.[0]?.link || "";
}

function eventImage(event) {
  const image = Array.isArray(event.images) ? event.images.find((item) => item.url) : null;
  return image || null;
}

function eventMatches(event) {
  if (state.view === "saved" && !state.saved.has(event.id)) return false;
  if (state.view === "tonight") {
    if (!event.start_time || !Number.isFinite(eventStart(event))) return false;
    const now = new Date();
    const helsinkiNow = new Intl.DateTimeFormat("en-CA", { timeZone: HELSINKI_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const start = new Intl.DateTimeFormat("en-CA", { timeZone: HELSINKI_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(event.start_time));
    if (helsinkiNow !== start) return false;
  }
  if (state.filter === "free" && eventPrice(event) !== "Free") return false;
  if (["nightlife", "music", "culture"].includes(state.filter) && eventCategory(event) !== state.filter) return false;
  const query = state.query.trim().toLowerCase();
  if (query) {
    const searchable = [eventName(event), venueName(event), venueAddress(event), plainText(lang(event.description))].join(" ").toLowerCase();
    if (!searchable.includes(query)) return false;
  }
  return true;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderSkeletons() {
  const grid = $("#event-grid");
  grid.replaceChildren(...Array.from({ length: 8 }, () => makeElement("div", "skeleton")));
  $("#results-meta").textContent = "Finding the good stuff…";
  $("#empty-state").hidden = true;
}

function createEventCard(event) {
  const article = makeElement("article", "event-card");
  const open = makeElement("div", "event-card-main");
  open.setAttribute("role", "button");
  open.tabIndex = 0;
  open.setAttribute("aria-label", `View ${eventName(event)}, ${formatDate(event, true)}`);
  const imageWrap = makeElement("div", "event-image-wrap");
  const placeholder = makeElement("div", "event-placeholder");
  placeholder.append(makeElement("span", "", "✳"), makeElement("small", "", "HELSINKI AFTER HOURS"));
  const image = eventImage(event);
  if (image?.url) {
    const img = makeElement("img", "event-image");
    img.src = image.url;
    img.alt = image.alt_text || `${eventName(event)} event artwork`;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("load", () => placeholder.remove(), { once: true });
    img.addEventListener("error", () => img.remove(), { once: true });
    imageWrap.append(img);
  }
  imageWrap.append(placeholder);
  const tag = makeElement("span", "event-tag", categoryLabel(event));
  imageWrap.append(tag);
  const save = makeElement("button", `save-event${state.saved.has(event.id) ? " saved" : ""}`, state.saved.has(event.id) ? "♥" : "♡");
  save.type = "button";
  save.setAttribute("aria-label", state.saved.has(event.id) ? `Remove ${eventName(event)} from saved events` : `Save ${eventName(event)}`);
  save.setAttribute("aria-pressed", String(state.saved.has(event.id)));
  save.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSaved(event.id);
  });
  imageWrap.append(save);

  const body = makeElement("div", "event-card-body");
  body.append(makeElement("div", "event-date", formatDate(event, true)));
  body.append(makeElement("h3", "event-title", eventName(event)));
  const venue = makeElement("div", "event-venue");
  venue.append(makeElement("span", "", "⌖"), document.createTextNode(venueName(event)));
  body.append(venue);
  const footer = makeElement("div", "card-footer");
  const price = makeElement("span", `event-price${eventPrice(event) === "Free" ? " free" : ""}`, eventPrice(event));
  footer.append(price, makeElement("span", "card-arrow", "↗"));
  body.append(footer);
  open.append(imageWrap, body);
  open.addEventListener("click", () => openEvent(event));
  open.addEventListener("keydown", (e) => {
    if (e.target === open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openEvent(event);
    }
  });
  article.append(open);
  return article;
}

function renderEvents() {
  const grid = $("#event-grid");
  const filtered = state.events.filter(eventMatches);
  grid.replaceChildren(...filtered.map(createEventCard));
  $("#results-meta").textContent = `${filtered.length} ${filtered.length === 1 ? "event" : "events"}${state.lastUpdated ? ` · UPDATED ${formatUpdated(state.lastUpdated)}` : ""}`;
  $("#feed-updated").textContent = state.lastUpdated ? formatUpdated(state.lastUpdated) : "when feed loads";
  $("#empty-state").hidden = filtered.length > 0;
  $("#load-more").hidden = !state.nextUrl || state.view === "saved";
  $("#hero-event-count").textContent = state.events.length ? `${state.events.length} PLANS IN THE MIX` : "NEW PLANS LANDING SOON";
  renderVenues();
}

function formatUpdated(date) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: HELSINKI_TZ }).format(date);
}

async function initializeAnalytics() {
  const config = window.ILTA_SUPABASE_CONFIG;
  if (!config?.url || !config?.anonKey || analyticsClient) return;

  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    analyticsClient = createClient(config.url, config.anonKey);
    visitorSessionId = sessionStorage.getItem("ilta-visitor-session");
    if (!visitorSessionId) {
      visitorSessionId = crypto.randomUUID();
      sessionStorage.setItem("ilta-visitor-session", visitorSessionId);
    }
    await sendHeartbeat();
    window.setInterval(sendHeartbeat, 60_000);
  } catch (error) {
    console.error("Ilta analytics could not connect to Supabase:", error);
  }
}

async function sendHeartbeat() {
  if (!analyticsClient || !visitorSessionId) return;
  try {
    const { error } = await analyticsClient.rpc("ilta_heartbeat", { p_session_id: visitorSessionId });
    if (error && !analyticsErrorReported) {
      analyticsErrorReported = true;
      console.error("Ilta could not update the active visitor session:", error);
    }
  } catch (error) {
    if (!analyticsErrorReported) {
      analyticsErrorReported = true;
      console.error("Ilta could not update the active visitor session:", error);
    }
  }
}

async function trackOutboundClick(link) {
  if (!analyticsClient || !visitorSessionId) return;
  try {
    const { error } = await analyticsClient.rpc("ilta_track_click", {
      p_session_id: visitorSessionId,
      p_destination: link.dataset.analyticsKind,
      p_event_id: link.dataset.eventId || null,
      p_event_name: link.dataset.eventName || null,
    });
    if (error && !analyticsErrorReported) {
      analyticsErrorReported = true;
      console.error("Ilta could not record an outbound click:", error);
    }
  } catch (error) {
    if (!analyticsErrorReported) {
      analyticsErrorReported = true;
      console.error("Ilta could not record an outbound click:", error);
    }
  }
}

function setAnalyticsConsent(value) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch (error) {
    console.error("Unable to save Ilta analytics privacy settings:", error);
  }
  $("#analytics-consent").hidden = true;
  if (value === "accepted") initializeAnalytics();
}

function rememberVenues(events) {
  for (const event of events) {
    const place = eventLocation(event);
    if (!place?.id) continue;
    if (!state.venues.has(place.id)) state.venues.set(place.id, { place, events: [] });
    const venue = state.venues.get(place.id);
    if (!venue.events.some((item) => item.id === event.id)) venue.events.push(event);
  }
}

function venueMatches(venue) {
  const place = venue.place;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return [lang(place.name), lang(place.street_address), lang(place.description)].join(" ").toLowerCase().includes(query);
}

function renderVenues() {
  const grid = $("#venue-grid");
  const venues = [...state.venues.values()].filter(venueMatches).sort((a, b) => lang(a.place.name).localeCompare(lang(b.place.name))).slice(0, 24);
  grid.replaceChildren(...venues.map(({ place, events }) => {
    const button = makeElement("button", "venue-card");
    button.type = "button";
    const image = place.image?.url;
    if (image) {
      const img = makeElement("img");
      img.src = image;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      button.append(img);
    }
    button.append(makeElement("span", "", `${events.length} ${events.length === 1 ? "event" : "events"} listed`));
    button.append(makeElement("b", "", lang(place.name, "Helsinki venue")));
    button.append(makeElement("small", "", lang(place.street_address) || lang(place.address_locality) || "Helsinki"));
    button.addEventListener("click", () => openVenue(place.id));
    return button;
  }));
  $("#venue-empty").hidden = venues.length > 0;
}

function setView(view) {
  state.view = view;
  $("#section-title").innerHTML = view === "tonight"
    ? 'Tonight in <span class="muted">Helsinki.</span>'
    : view === "saved"
      ? 'Your <span class="muted">saved plans.</span>'
      : 'Find your <span class="muted">next thing.</span>';
  const venues = view === "venues";
  $("#venues-section").hidden = !venues;
  $("#events-section").hidden = venues;
  $$(".nav-link, .mobile-nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (!venues) renderEvents();
  if (view === "tonight") $("#section-title").scrollIntoView({ block: "start", behavior: "smooth" });
  else if (view === "venues") $("#venues-section").scrollIntoView({ block: "start", behavior: "smooth" });
  else if (view === "saved") $("#events-section").scrollIntoView({ block: "start", behavior: "smooth" });
}

function toggleSaved(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  saveSaved();
  renderEvents();
  if (state.activeEvent?.id === id) updateDetailSave();
}

function updateDetailSave() {
  const saved = state.saved.has(state.activeEvent.id);
  $("#detail-save").textContent = saved ? "♥ Saved" : "♡ Save event";
  $("#detail-save").setAttribute("aria-pressed", String(saved));
}

function openEvent(event) {
  state.activeEvent = event;
  state.zoom = 1;
  const dialog = $("#detail-dialog");
  const image = eventImage(event);
  $("#detail-title").textContent = eventName(event);
  $("#detail-kicker").textContent = categoryLabel(event).toUpperCase() + " · HELSINKI";
  $("#detail-date").textContent = formatDate(event);
  $("#detail-venue").textContent = `${venueName(event)} · ${venueAddress(event)}`;
  $("#detail-price").textContent = eventPrice(event);
  $("#detail-description").textContent = plainText(lang(event.description)) || "No event description has been provided. Check the organiser's event page for the latest details.";
  const link = $("#official-link");
  const href = officialUrl(event);
  link.href = href || "#";
  link.hidden = !href;
  link.dataset.analyticsKind = eventOffer(event) ? "ticket" : "event";
  link.dataset.eventId = event.id;
  link.dataset.eventName = eventName(event);
  link.setAttribute("aria-label", href ? `Open the official event page for ${eventName(event)}` : "No official event page supplied");
  const detailImage = $("#detail-image");
  const placeholder = $("#flyer-placeholder");
  const credit = $("#flyer-credit");
  if (image?.url) {
    detailImage.src = image.url;
    detailImage.alt = image.alt_text || `${eventName(event)} official event artwork`;
    detailImage.hidden = false;
    detailImage.style.transform = "scale(1)";
    placeholder.hidden = true;
    const creditText = [image.photographer_name ? `Photo: ${image.photographer_name}` : "", image.license ? `Image license: ${image.license}` : ""].filter(Boolean).join(" · ");
    credit.textContent = creditText;
  } else {
    detailImage.removeAttribute("src");
    detailImage.hidden = true;
    placeholder.hidden = false;
    credit.textContent = "No official artwork supplied with this listing.";
  }
  updateDetailSave();
  dialog.showModal();
}

function openVenue(id) {
  const data = state.venues.get(id);
  if (!data) return;
  const { place, events } = data;
  $("#venue-title").textContent = lang(place.name, "Helsinki venue");
  $("#venue-address").textContent = [lang(place.street_address), lang(place.address_locality)].filter(Boolean).join(", ");
  $("#venue-description").textContent = lang(place.description) || "Venue details provided by Helsinki Linked Events.";
  const imageWrap = $("#venue-dialog-image");
  imageWrap.replaceChildren();
  if (place.image?.url) {
    const image = makeElement("img");
    image.src = place.image.url;
    image.alt = place.image.alt_text || `${lang(place.name)} venue`;
    image.loading = "lazy";
    imageWrap.append(image);
  }
  const venueLink = $("#venue-link");
  const url = lang(place.info_url);
  venueLink.href = url || "#";
  venueLink.hidden = !url;
  venueLink.dataset.analyticsKind = "venue";
  venueLink.dataset.eventId = id;
  venueLink.dataset.eventName = lang(place.name, "Helsinki venue");
  const rows = events.slice().sort((a, b) => eventStart(a) - eventStart(b)).slice(0, 6).map((event) => {
    const row = makeElement("button", "venue-event-row");
    row.type = "button";
    row.append(makeElement("span", "", eventName(event)), makeElement("span", "", formatDate(event, true)));
    row.addEventListener("click", () => {
      $("#venue-dialog").close();
      openEvent(event);
    });
    return row;
  });
  $("#venue-events").replaceChildren(...rows);
  $("#venue-dialog").showModal();
}

function setFilter(filter) {
  state.filter = filter;
  $$(".filter-chip").forEach((button) => button.classList.toggle("selected", button.dataset.filter === filter));
  renderEvents();
}

async function fetchEvents(url = API_URL, append = false) {
  const refresh = $("#refresh-button");
  if (!append) {
    refresh.classList.add("loading");
    renderSkeletons();
  }
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Event feed returned ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error("Event feed response did not contain an event list");
    const incoming = payload.data.filter((event) => event && event.id);
    state.events = append
      ? [...state.events, ...incoming.filter((event) => !state.events.some((existing) => existing.id === event.id))]
      : incoming;
    state.nextUrl = payload.meta?.next || null;
    rememberVenues(incoming);
    state.events.sort((a, b) => eventStart(a) - eventStart(b));
    state.lastUpdated = new Date();
    $("#live-label").textContent = `HELSINKI, LIVE · ${formatUpdated(state.lastUpdated)}`;
    const heroEvent = state.events.find((event) => eventImage(event)?.url);
    if (heroEvent) {
      const heroImage = eventImage(heroEvent);
      const art = $("#hero-art");
      art.style.backgroundImage = `url("${heroImage.url.replaceAll('"', "%22")}")`;
      art.classList.add("ready");
    }
    renderEvents();
  } catch (error) {
    console.error("Unable to load Helsinki events:", error);
    if (!append) {
      $("#event-grid").replaceChildren();
      $("#results-meta").textContent = "The live event feed is unavailable right now.";
      $("#empty-state").hidden = false;
      $("#empty-state h3").textContent = "The city feed is taking a breather.";
      $("#empty-state p").textContent = "Please try again in a moment. We couldn't load verified event listings.";
      $("#load-more").hidden = true;
      $("#hero-event-count").textContent = "CHECK BACK IN A MOMENT";
    }
  } finally {
    refresh.classList.remove("loading");
  }
}

function initialize() {
  updateSavedCount();
  renderSkeletons();
  let analyticsConsent = null;
  try {
    analyticsConsent = localStorage.getItem(CONSENT_KEY);
  } catch (error) {
    console.error("Unable to read Ilta analytics privacy settings:", error);
  }
  if (analyticsConsent === "accepted") initializeAnalytics();
  else if (analyticsConsent !== "declined") $("#analytics-consent").hidden = false;

  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) setView(viewButton.dataset.view);
    const outboundLink = event.target.closest("a[data-analytics-kind]");
    if (outboundLink && !outboundLink.hidden && outboundLink.href !== "#") trackOutboundClick(outboundLink);
  });
  $("#consent-accept").addEventListener("click", () => setAnalyticsConsent("accepted"));
  $("#consent-decline").addEventListener("click", () => setAnalyticsConsent("declined"));
  $("#privacy-settings").addEventListener("click", () => {
    $("#analytics-consent").hidden = false;
    $("#consent-accept").focus();
  });
  $$(".filter-chip").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
  $("#event-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderEvents();
  });
  $$(".quick-searches button").forEach((button) => button.addEventListener("click", () => {
    state.query = button.dataset.query;
    $("#event-search").value = state.query;
    renderEvents();
    $("#event-search").focus();
  }));
  $("#refresh-button").addEventListener("click", () => fetchEvents());
  $("#load-more").addEventListener("click", () => state.nextUrl && fetchEvents(state.nextUrl, true));
  $("#clear-filters").addEventListener("click", () => {
    $("#event-search").value = "";
    state.query = "";
    setFilter("all");
  });
  $("#detail-save").addEventListener("click", () => state.activeEvent && toggleSaved(state.activeEvent.id));
  $("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
  $("#venue-close").addEventListener("click", () => $("#venue-dialog").close());
  for (const [selector, change] of [["#zoom-in", 0.25], ["#zoom-out", -0.25]]) {
    $(selector).addEventListener("click", () => {
      state.zoom = Math.min(2.5, Math.max(1, state.zoom + change));
      $("#detail-image").style.transform = `scale(${state.zoom})`;
    });
  }
  $("#detail-dialog").addEventListener("click", (event) => {
    if (event.target === $("#detail-dialog")) $("#detail-dialog").close();
  });
  $("#venue-dialog").addEventListener("click", (event) => {
    if (event.target === $("#venue-dialog")) $("#venue-dialog").close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      $("#event-search").focus();
    }
  });
  fetchEvents();
  window.setInterval(() => fetchEvents(), REFRESH_INTERVAL);
}

initialize();
