if (!globalThis.GCFY && typeof importScripts === "function")
  importScripts("shared.js");
// Service worker (background script in Firefox): the only part that talks to
// Tenor. It hands the content script a short list of
// { id, title, preview, width, height }.
//
// YouTube only takes GIFs that Tenor rates G, and Tenor's pages do not say how
// a GIF is rated. Tenor's API does, and it answers to the key that every
// tenor.com page carries for the site's own scripts. Lists therefore come from
// the API, filtered to G. If the API does not answer, they come from the result
// data Tenor embeds in its pages, unrated, as they did before.

const TENOR = "https://tenor.com";
const TENOR_API = "https://tenor.googleapis.com/v2";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;
const TENOR_TIMEOUT_MS = 10000;

// url -> { time, value }
const cache = new Map();
const pending = new Map();

// Chrome does not run content scripts in tabs that were already open when the
// extension is installed, so they are injected here once. Both files ignore a
// second copy of themselves.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const tabs = await chrome.tabs.query({
    url: "https://www.youtube.com/*",
    discarded: false,
  });
  await Promise.all(
    tabs.map(async ({ id: tabId }) => {
      const target = { tabId };
      try {
        await chrome.scripting.executeScript({
          target,
          files: ["src/main.js"],
          world: "MAIN",
        });
        await chrome.scripting.insertCSS({
          target,
          files: ["src/content.css"],
        });
        await chrome.scripting.executeScript({
          target,
          files: ["src/shared.js", "src/content.js"],
        });
      } catch (e) {
        /* the tab closed or navigated away; it gets the scripts on its next load */
      }
    }),
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(
    (value) =>
      sendResponse({
        ok: true,
        ...(Array.isArray(value) ? { gifs: value } : value),
      }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

async function handle(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string")
    throw new Error("Bad request.");
  if (msg.type.startsWith("library:")) return library(msg);
  if (msg.type === "featured") return featured(msg.pos, msg.locale);
  if (msg.type === "search" && typeof msg.query === "string")
    return search(msg.query.slice(0, 200), msg.pos, msg.locale);
  if (msg.type === "resolve" && typeof msg.input === "string")
    return resolve(msg.input.slice(0, 2048));
  if (
    msg.type === "check" &&
    typeof msg.id === "string" &&
    /^\d{1,20}$/.test(msg.id)
  )
    return check(msg.id);
  throw new Error("Bad request.");
}

async function cached(url, load) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  if (pending.has(url)) return pending.get(url);
  const promise = load()
    .then((value) => {
      cache.set(url, { time: Date.now(), value });
      if (cache.size > 40) cache.delete(cache.keys().next().value);
      return value;
    })
    .finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

// A tenor.com page as { store, keys }: the results it shows, and the two
// values its own scripts send to Tenor's API (null if they cannot be read).
function fetchPage(url) {
  return cached(url, async () => {
    const res = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      signal: AbortSignal.timeout(TENOR_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? "Tenor could not find that GIF."
          : `Tenor returned HTTP ${res.status}.`,
      );
    if (new URL(res.url).origin !== TENOR)
      throw new Error("Tenor redirected somewhere unexpected.");
    const html = await res.text();
    const m = html.match(
      /<script id="store-cache" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!m)
      throw new Error("Tenor changed its page format; search is unavailable.");
    return { store: JSON.parse(m[1]), keys: readKeys(html) };
  });
}

// The site's settings are base64 JSON in a second script element.
function readKeys(html) {
  const m = html.match(
    /<script id="data" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/,
  );
  try {
    const data = JSON.parse(atob(m[1].trim()));
    if (
      typeof data.API_V2_KEY === "string" &&
      typeof data.API_V2_CLIENT_KEY === "string"
    ) {
      return { key: data.API_V2_KEY, client_key: data.API_V2_CLIENT_KEY };
    }
  } catch (e) {
    /* no keys: the callers fall back to the page's own results */
  }
  return null;
}

// One call to Tenor's API, returning its results array. contentfilter=high
// asks for G-rated GIFs only.
async function fetchApi(path, params) {
  const { keys } = await fetchPage(`${TENOR}/`);
  if (!keys)
    throw new Error("Tenor changed its page format; ratings are unavailable.");
  const query = new URLSearchParams({
    ...keys,
    contentfilter: "high",
    media_filter: "tinygif,tinywebp,gif",
    ...params,
  });
  const url = `${TENOR_API}${path}?${query}`;
  return cached(url, async () => {
    const res = await fetch(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(TENOR_TIMEOUT_MS),
    });
    if (!res.ok)
      throw new Error(
        res.status === 429
          ? "Tenor is busy. Try again later."
          : `Tenor returned HTTP ${res.status}.`,
      );
    const { results, next } = await res.json();
    if (!Array.isArray(results))
      throw new Error("Tenor sent an answer that could not be read.");
    return {
      results,
      next: typeof next === "string" ? next.slice(0, 500) : "",
    };
  });
}

// Unrated results may be displayed; posting requires verification.
const ratedG = (r) =>
  typeof r.content_rating !== "string" || r.content_rating === "G";

function toGif(r) {
  if (!r || !/^\d{1,20}$/.test(String(r.id)) || !r.media_formats) return null;
  const flags =
    Array.isArray(r.flags) || typeof r.flags === "string" ? r.flags : [];
  if (flags.includes("sticker") || flags.includes("static")) return null;
  const f =
    r.media_formats.tinygif || r.media_formats.tinywebp || r.media_formats.gif;
  if (
    !f ||
    typeof f.url !== "string" ||
    !/^https:\/\/media\d*\.tenor\.com\//.test(f.url)
  )
    return null;
  const dims = Array.isArray(f.dims) ? f.dims : [];
  return GCFY.validGif({
    id: String(r.id),
    title: String(r.content_description || r.h1_title || "GIF").slice(0, 200),
    preview: f.url,
    width: dims[0] || 220,
    height: dims[1] || 124,
    // Only Tenor's API gives ratings; results from its web pages have none.
    contentRating:
      typeof r.content_rating === "string" ? r.content_rating : null,
    verifiedAt: typeof r.content_rating === "string" ? Date.now() : 0,
  });
}

const toGifs = (results) =>
  (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

function pageParams(pos, locale) {
  const params = {
    limit: MAX_RESULTS,
    locale: /^[a-z]{2}(?:[_-][A-Za-z]{2})?$/.test(locale || "")
      ? locale
      : "en_US",
  };
  if (typeof pos === "string" && pos.length <= 500) params.pos = pos;
  return params;
}
async function featured(pos, locale) {
  try {
    const page = await fetchApi("/featured", pageParams(pos, locale));
    return { gifs: toGifs(page.results.filter(ratedG)), next: page.next };
  } catch (error) {
    if (pos) throw error;
    const { store } = await fetchPage(TENOR + "/");
    return {
      gifs: toGifs(store.gifs?.featured?.results),
      next: "",
      degraded: true,
    };
  }
}
async function search(query, pos, locale) {
  const slug = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("-");
  if (!slug) return featured(pos, locale);
  try {
    const page = await fetchApi("/search", {
      ...pageParams(pos, locale),
      q: query.trim(),
    });
    return { gifs: toGifs(page.results.filter(ratedG)), next: page.next };
  } catch (error) {
    if (pos) throw error;
    const { store } = await fetchPage(TENOR + "/search/" + slug + "-gifs");
    const searches = Object.values(store.universal?.search || {});
    return { gifs: toGifs(searches[0]?.results), next: "", degraded: true };
  }
}

// Accepts a tenor.com page link, a tenor.com short link, a media.tenor.com
// file link or a bare numeric ID, and returns the one GIF it points at. The
// GIF's page gives its current ID, which an old link does not; the API then
// gives its rating.
async function resolve(input) {
  const text = input.trim();
  let pageUrl;
  if (/^\d{1,20}$/.test(text)) {
    pageUrl = `${TENOR}/view/x-gif-${text}`;
  } else {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch (e) {
      throw new Error("That is not a Tenor link.");
    }
    if (/^media\d*\.tenor\.com$/.test(url.hostname)) {
      // media IDs are the base64 of the 64-bit GIF ID followed by a format code
      const mediaId = url.pathname
        .split("/")
        .filter(Boolean)
        .find((p) => /^[A-Za-z0-9_-]{16}$/.test(p));
      if (!mediaId) throw new Error("That is not a Tenor GIF link.");
      pageUrl = `${TENOR}/view/x-gif-${decodeMediaId(mediaId)}`;
    } else if (
      url.hostname === "tenor.com" ||
      url.hostname === "www.tenor.com"
    ) {
      pageUrl = `${TENOR}${url.pathname}`;
    } else {
      throw new Error("That is not a Tenor link.");
    }
  }
  const { store } = await fetchPage(pageUrl);
  const entries = Object.values((store.gifs && store.gifs.byId) || {});
  const gifs = toGifs(
    entries.flatMap((e) => (e && e.results) || []).slice(0, 1),
  );
  if (!gifs.length) throw new Error("That link does not point at a GIF.");
  let rated = [];
  try {
    rated = (
      await fetchApi("/posts", { ids: gifs[0].id, contentfilter: "off" })
    ).results;
  } catch (e) {
    /* rating unknown: offer the GIF and let YouTube decide */
  }
  const post = rated.find((r) => r && String(r.id) === gifs[0].id);
  if (post && !ratedG(post)) {
    throw new Error(
      `YouTube only takes GIFs that Tenor rates G. This one is rated ${post.content_rating}.`,
    );
  }
  if (post) gifs[0].contentRating = post.content_rating;
  return gifs;
}

// The exact GIF about to be posted, with its current rating, for one that was
// picked without a known rating (a favorite, or a result from Tenor's web
// pages). An empty list means Tenor did not return it.
async function check(id) {
  const { results } = await fetchApi("/posts", {
    ids: id,
    contentfilter: "off",
  });
  const post = results.find((r) => r && String(r.id) === id);
  const gif = post && toGif(post);
  return gif ? [gif] : [];
}

function decodeMediaId(mediaId) {
  const bin = atob(
    mediaId.slice(0, 11).replace(/-/g, "+").replace(/_/g, "/") + "=",
  );
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bin.charCodeAt(i));
  return n.toString();
}

// Serial read-modify-write operations prevent lost updates across tabs.
let libraryQueue = Promise.resolve();
function library(msg) {
  const operation = libraryQueue.then(async () => {
    const stored = await chrome.storage.local.get([
      "favorites",
      "recent",
      "recovery",
    ]);
    if (
      Array.isArray(stored.recovery) &&
      stored.recovery.some((d) => !d || d.time <= Date.now() - 86400000)
    ) {
      stored.recovery = stored.recovery.filter(
        (d) => d?.time > Date.now() - 86400000,
      );
      await chrome.storage.local.set({ recovery: stored.recovery });
    }
    let favorites = GCFY.list(stored.favorites),
      recent = GCFY.list(stored.recent, 30);
    const gif = GCFY.validGif(msg.gif);
    if (msg.type === "library:toggle") {
      if (!gif) throw new Error("Invalid GIF.");
      if (favorites.some((g) => g.id === gif.id))
        favorites = favorites.filter((g) => g.id !== gif.id);
      else {
        if (favorites.length >= 300)
          throw new Error("GIF limit reached (300). Remove a favorite first.");
        favorites.unshift(gif);
      }
      await chrome.storage.local.set({ favorites });
    } else if (msg.type === "library:recent") {
      if (!gif) throw new Error("Invalid GIF.");
      recent = [gif, ...recent.filter((g) => g.id !== gif.id)].slice(0, 30);
      await chrome.storage.local.set({ recent });
    } else if (msg.type === "library:import") {
      if (!Array.isArray(msg.gifs) || msg.gifs.length > 300)
        throw new Error("Invalid favorites file.");
      const imported = GCFY.list(msg.gifs);
      if (imported.length !== msg.gifs.length)
        throw new Error("Invalid favorites file.");
      favorites = GCFY.list([...favorites, ...imported]);
      await chrome.storage.local.set({ favorites });
    } else if (msg.type === "library:clearRecent") {
      recent = [];
      await chrome.storage.local.set({ recent });
    } else if (msg.type === "library:recover") {
      const draft = msg.draft;
      if (
        !draft ||
        typeof draft.text !== "string" ||
        draft.text.length > 20000 ||
        !/^[a-zA-Z0-9_-]{11}$/.test(draft.videoId)
      )
        throw new Error("Invalid draft.");
      const clean = {
        key: String(draft.key).slice(0, 100),
        videoId: draft.videoId,
        text: draft.text,
        gif: GCFY.validGif(draft.gif),
        time: Date.now(),
      };
      const recovery = (Array.isArray(stored.recovery) ? stored.recovery : [])
        .filter((d) => d?.key !== clean.key && d?.time > Date.now() - 86400000)
        .slice(0, 9);
      recovery.unshift(clean);
      await chrome.storage.local.set({ recovery });
    } else if (msg.type === "library:forgetDraft") {
      await chrome.storage.local.set({
        recovery: (Array.isArray(stored.recovery)
          ? stored.recovery
          : []
        ).filter((d) => d.key !== msg.key && d.time > Date.now() - 86400000),
      });
    } else if (msg.type === "library:clearDrafts")
      await chrome.storage.local.remove("recovery");
    else if (msg.type !== "library:get") throw new Error("Bad request.");
    return { favorites, recent };
  });
  libraryQueue = operation.catch(() => {});
  return operation;
}
