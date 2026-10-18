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
  cityEvents: [],
  communityEvents: [],
  communityFeedAvailable: false,
  nextUrl: null,
  filter: "nightlife",
  query: "",
  view: "discover",
  saved: readSaved(),
  activeEvent: null,
  zoom: 1,
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
  if (/club|night ?life|nightclub|after ?party|rave|dj|dance|disco|party|yökerho|klubi|bile|tanssi/.test(text)) return "nightlife";
  if (/concert|live music|keikka|music|musiik|konser|jazz|rock|band|orkester|sound|sing|song/.test(text)) return "music";
  if (/exhibition|museum|theatre|theater|art|gallery|culture|näyttely|teatter|taide|kulttuur|elokuva|film/.test(text)) return "culture";
  return "event";
}

function categoryLabel(event) {
  const category = eventCategory(event);
  return category === "nightlife" ? "Club & party" : category === "music" ? "Music" : "Helsinki event";
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

function mapApprovedEvent(row) {
  return {
    id: `ilta:${row.id}`,
    name: row.title,
    description: row.description || "",
    start_time: row.starts_at,
    location: { name: row.venue, street_address: row.address || "" },
    offers: [{ is_free: row.is_free, price: row.price || "", info_url: row.event_url }],
    info_url: row.event_url,
    images: row.image_url
      ? [{ url: row.image_url, alt_text: row.image_alt || `${row.title} event artwork`, license: "Supplied by organiser" }]
      : [],
    external_links: [{ link: row.event_url }],
    iltaSource: { name: row.source_name, kind: row.source_kind, url: row.source_url },
  };
}

async function loadApprovedEvents() {
  const config = window.ILTA_SUPABASE_CONFIG;
  if (!config?.url || !config?.anonKey) return [];

  const url = new URL("/rest/v1/ilta_events", config.url);
  url.searchParams.set("select", "*");
  url.searchParams.set("starts_at", `gte.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`);
  url.searchParams.set("order", "starts_at.asc");
  const response = await fetch(url, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
  });
  if (!response.ok) throw new Error(`Approved event feed returned ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Approved event feed did not return a list");
  return rows.map(mapApprovedEvent);
}

function isPaidEvent(event) {
  const offer = eventOffer(event);
  if (!offer || offer.is_free === true) return false;
  return offer.is_free === false || Boolean(lang(offer.price));
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
  if (state.filter === "free" && eventOffer(event)?.is_free !== true) return false;
  if (state.filter === "paid" && !isPaidEvent(event)) return false;
  if (state.filter === "nightlife" && eventCategory(event) !== "nightlife") return false;
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
  $("#empty-state h3").textContent = state.filter === "nightlife"
    ? "No club or party listings right now."
    : state.filter === "free"
      ? "No free-entry listings right now."
      : state.filter === "paid"
        ? "No paid or ticketed listings right now."
        : "No plans found. Yet.";
  $("#empty-state p").textContent = "Try another option or check again after the city event feed refreshes.";
  $("#empty-state").hidden = filtered.length > 0;
  $("#load-more").hidden = !state.nextUrl || state.view === "saved";
  $("#hero-event-count").textContent = state.events.length ? `${state.events.length} PLANS IN THE MIX` : "NEW PLANS LANDING SOON";
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

function setView(view) {
  state.view = view;
  $("#section-title").innerHTML = view === "tonight"
    ? 'Tonight in <span class="muted">Helsinki.</span>'
    : view === "saved"
      ? 'Your <span class="muted">saved plans.</span>'
      : 'Party &amp; club <span class="muted">events.</span>';
  $$(".nav-link, .mobile-nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  renderEvents();
  if (view === "tonight") $("#section-title").scrollIntoView({ block: "start", behavior: "smooth" });
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
  $(".detail-source").textContent = event.iltaSource
    ? `Reviewed from ${event.iltaSource.name} · Confirm latest details with the organiser.`
    : "Details from Helsinki Linked Events. Confirm the latest details with the organiser.";
  $("#share-status").textContent = "";
  updateDetailSave();
  dialog.showModal();
}

async function shareActiveEvent() {
  const event = state.activeEvent;
  if (!event) return;
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set("event", event.id);
  const shareData = {
    title: eventName(event),
    text: `${eventName(event)} · ${formatDate(event)} · ${venueName(event)} · ${eventPrice(event)}`,
    url: shareUrl.href,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
    if (!navigator.clipboard?.writeText) throw new Error("This browser does not support link sharing or clipboard access");
    await navigator.clipboard.writeText(shareUrl.href);
    $("#share-status").textContent = "Event link copied. Send it to your friends.";
  } catch (error) {
    if (error.name === "AbortError") return;
    console.error("Unable to share the Ilta event link:", error);
    $("#share-status").textContent = "Sharing failed. You can copy the event link from your browser address bar.";
  }
}

async function openSharedEvent() {
  const eventId = new URLSearchParams(window.location.search).get("event");
  if (!eventId) return;
  const event = state.events.find((item) => item.id === eventId);
  if (event) {
    openEvent(event);
    return;
  }
  try {
    if (eventId.startsWith("ilta:")) {
      const config = window.ILTA_SUPABASE_CONFIG;
      if (!config?.url || !config?.anonKey) throw new Error("Community event sharing is not configured");
      const url = new URL("/rest/v1/ilta_events", config.url);
      url.searchParams.set("select", "*");
      url.searchParams.set("id", `eq.${eventId.slice("ilta:".length)}`);
      url.searchParams.set("limit", "1");
      const response = await fetch(url, {
        headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}` },
      });
      if (!response.ok) throw new Error(`Shared Ilta event lookup returned ${response.status}`);
      const rows = await response.json();
      if (rows[0]) openEvent(mapApprovedEvent(rows[0]));
      return;
    }
    const response = await fetch(`https://api.hel.fi/linkedevents/v1/event/${encodeURIComponent(eventId)}/?include=location`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Shared event lookup returned ${response.status}`);
    const payload = await response.json();
    if (!payload.id) throw new Error("Shared event lookup returned no event");
    openEvent(payload);
  } catch (error) {
    console.error("Unable to open the shared Helsinki event:", error);
  }
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
  const errors = [];
  let cityLoaded = false;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Event feed returned ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error("Event feed response did not contain an event list");
    const incoming = payload.data.filter((event) => event && event.id);
    state.cityEvents = append
      ? [...state.cityEvents, ...incoming.filter((event) => !state.cityEvents.some((existing) => existing.id === event.id))]
      : incoming;
    state.nextUrl = payload.meta?.next || null;
    cityLoaded = true;
  } catch (error) {
    console.error("Unable to load Helsinki city events:", error);
    errors.push("Helsinki city events are temporarily unavailable.");
    if (!append) {
      state.cityEvents = [];
      state.nextUrl = null;
    }
  }

  let communityLoaded = state.communityFeedAvailable;
  if (!append) {
    try {
      state.communityEvents = await loadApprovedEvents();
      state.communityFeedAvailable = Boolean(window.ILTA_SUPABASE_CONFIG?.url && window.ILTA_SUPABASE_CONFIG?.anonKey);
      communityLoaded = true;
    } catch (error) {
      console.error("Unable to load approved organiser and social events:", error);
      errors.push("Approved organiser and social events are temporarily unavailable.");
      state.communityEvents = [];
      state.communityFeedAvailable = false;
    }
  }

  state.events = [...state.cityEvents, ...state.communityEvents]
    .filter((event, index, items) => items.findIndex((item) => item.id === event.id) === index)
    .sort((a, b) => eventStart(a) - eventStart(b));
  state.lastUpdated = new Date();
  $("#live-label").textContent = `${cityLoaded ? "HELSINKI, LIVE" : "APPROVED EVENTS"} · ${formatUpdated(state.lastUpdated)}`;
  $("#connection-status").textContent = !window.ILTA_SUPABASE_CONFIG?.url || !window.ILTA_SUPABASE_CONFIG?.anonKey
    ? "Organiser submissions and social accounts need Supabase setup."
    : !cityLoaded && communityLoaded
      ? "Helsinki feed unavailable; showing approved organiser and social events."
    : communityLoaded
      ? "Approved organiser events · social posts added after admin review."
      : "Community events unavailable; showing Helsinki city listings.";
  if (!cityLoaded && errors.length && !state.communityEvents.length && !state.cityEvents.length) {
    $("#empty-state").hidden = false;
    $("#empty-state h3").textContent = "Event sources are unavailable.";
    $("#empty-state p").textContent = errors.join(" ");
    $("#results-meta").textContent = "Could not load event listings.";
    $("#hero-event-count").textContent = "CHECK BACK IN A MOMENT";
    $("#load-more").hidden = true;
  } else {
    renderEvents();
  }
  if (!append) openSharedEvent();
  if (append && !cityLoaded && errors.length) {
    $("#results-meta").textContent = `${state.events.length} events · ${errors[0]}`;
  }
  refresh.classList.remove("loading");
}

function initializeOrganizerSubmission() {
  const form = $("#event-submission-form");
  const button = form.querySelector("button[type=submit]");
  const message = $("#submission-message");
  const config = window.ILTA_SUPABASE_CONFIG;
  if (!config?.url || !config?.anonKey) {
    button.disabled = true;
    message.textContent = "Online submissions are not enabled yet. Please check back after setup.";
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const eventUrl = String(values.get("event_url") || "").trim();
    const imageUrl = String(values.get("image_url") || "").trim();
    const isFree = values.get("is_free") === "on";
    const price = String(values.get("price") || "").trim();
    if (!isFree && !price) {
      message.textContent = "Enter the confirmed entry price, or mark the event as free.";
      message.classList.add("error");
      return;
    }
    if (!eventUrl.startsWith("https://") || (imageUrl && !imageUrl.startsWith("https://"))) {
      message.textContent = "Use secure https:// links for the official event page and flyer.";
      message.classList.add("error");
      return;
    }
    const startsAt = new Date(String(values.get("starts_at") || ""));
    if (!Number.isFinite(startsAt.getTime())) {
      message.textContent = "Enter a valid event date and time.";
      message.classList.add("error");
      return;
    }

    button.disabled = true;
    message.classList.remove("error");
    message.textContent = "Sending for review…";
    const submission = {
      title: String(values.get("title") || "").trim(),
      organizer_name: String(values.get("organizer_name") || "").trim(),
      starts_at: startsAt.toISOString(),
      venue: String(values.get("venue") || "").trim(),
      address: String(values.get("address") || "").trim(),
      event_url: eventUrl,
      image_url: imageUrl || null,
      image_alt: String(values.get("image_alt") || "").trim(),
      is_free: isFree,
      price: isFree ? "Free" : price,
      description: String(values.get("description") || "").trim(),
    };
    try {
      const response = await fetch(new URL("/rest/v1/ilta_submissions", config.url), {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(submission),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Event submission returned ${response.status}: ${detail}`);
      }
      form.reset();
      message.textContent = "Thanks. Your event is in the review queue and will appear only after approval.";
    } catch (error) {
      console.error("Unable to submit event for review:", error);
      message.classList.add("error");
      message.textContent = "We couldn't send this event. Check the details and try again later.";
    } finally {
      button.disabled = false;
    }
  });
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
  $("#refresh-button").addEventListener("click", () => fetchEvents());
  $("#load-more").addEventListener("click", () => state.nextUrl && fetchEvents(state.nextUrl, true));
  $("#clear-filters").addEventListener("click", () => {
    $("#event-search").value = "";
    state.query = "";
    setFilter("all");
  });
  $("#detail-save").addEventListener("click", () => state.activeEvent && toggleSaved(state.activeEvent.id));
  $("#detail-share").addEventListener("click", shareActiveEvent);
  $("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
  for (const [selector, change] of [["#zoom-in", 0.25], ["#zoom-out", -0.25]]) {
    $(selector).addEventListener("click", () => {
      state.zoom = Math.min(2.5, Math.max(1, state.zoom + change));
      $("#detail-image").style.transform = `scale(${state.zoom})`;
    });
  }
  $("#detail-dialog").addEventListener("click", (event) => {
    if (event.target === $("#detail-dialog")) $("#detail-dialog").close();
  });
  initializeOrganizerSubmission();
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
