// Isolated-world content script: adds a GIF button to YouTube's comment boxes,
// shows the picker, attaches the chosen GIF to the box, and when the user posts
// hands it to the page-world hook (main.js) by submitting a one-time marker
// through YouTube's own comment box.
(() => {
  // sw.js also injects this file into tabs that were open before the install;
  // a tab must not end up with two copies.
  if (globalThis.gcfyLoaded) return;
  globalThis.gcfyLoaded = true;
  const { t, resultText } = GCFY;

  const BOX_SCOPE =
    "ytd-comment-simplebox-renderer, ytd-comment-thread-renderer";
  const POST_DIALOG = "ytd-backstage-post-dialog-renderer";
  const PICKER_W = 340;
  const PICKER_H = 480;
  const SEARCH_DEBOUNCE_MS = 350;
  const ARM_TIMEOUT_MS = 1500;
  const SUBMIT_GRACE_MS = 4000;
  // Wait for one publication attempt; no automatic retries.
  const RESULT_TIMEOUT_MS = 30000;
  // How long a post waits for Tenor to rate a GIF picked without a rating.
  const CHECK_TIMEOUT_MS = 5000;
  const NO_FAVORITES = "No favorites yet. Point at a GIF and click its star.";

  const PICKER_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; }
    .panel {
      --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.12); --field: rgba(0,0,0,.05); --accent: #065fd4; --err: #c00;
      --thumb: rgba(0,0,0,.25); --thumb-hover: rgba(0,0,0,.45);
      box-sizing: border-box; display: flex; flex-direction: column;
      width: min(${PICKER_W}px, calc(100vw - 16px)); background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      font: 13px/1.4 Roboto, Arial, sans-serif;
    }
    .panel[data-dark] {
      --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.14); --field: rgba(255,255,255,.08); --accent: #3ea6ff; --err: #ff7b7b;
      --thumb: rgba(255,255,255,.25); --thumb-hover: rgba(255,255,255,.45);
    }
    .search { flex: none; display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); }
    input {
      box-sizing: border-box; flex: 1; min-width: 0; height: 34px; padding: 0 12px;
      border: 1px solid transparent; border-radius: 17px; outline: none;
      background: var(--field); color: var(--fg); font: inherit;
    }
    input:focus { border-color: var(--accent); }
    input::placeholder { color: var(--muted); }
    .fav-tab {
      flex: none; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%;
      background: var(--field); color: var(--muted); font: 16px/1 Arial, sans-serif; cursor: pointer;
    }
    .fav-tab[aria-pressed="true"] { background: var(--accent); color: var(--bg); }
    .fav-tab:focus-visible, .star:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .status { flex: none; padding: 6px 12px 0; color: var(--muted); }
    .status:empty { display: none; }
    .status[data-kind="error"] { color: var(--err); }
    .grid {
      flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 8px 2px 8px 8px;
      display: flex; align-items: flex-start; gap: 6px;
      scrollbar-gutter: stable;
    }
    /* Slim rounded scrollbar: a 6px thumb inside a 12px transparent track. */
    .grid::-webkit-scrollbar { width: 12px; }
    .grid::-webkit-scrollbar-track { background: transparent; }
    .grid::-webkit-scrollbar-thumb {
      border: 3px solid transparent; border-radius: 6px;
      background: var(--thumb); background-clip: content-box;
    }
    .grid::-webkit-scrollbar-thumb:hover { background: var(--thumb-hover); background-clip: content-box; }
    @supports not selector(::-webkit-scrollbar) {
      .grid { scrollbar-width: thin; scrollbar-color: var(--thumb) transparent; padding-right: 8px; }
    }
    .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .tile {
      display: block; width: 100%; margin: 0; padding: 0; border: 0; border-radius: 8px;
      overflow: hidden; background: var(--field); cursor: pointer;
    }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tile:hover img { opacity: .82; }
    .tile img { display: block; width: 100%; height: auto; }
    /* The star is the tile's sibling, not its child: a button cannot hold another button. */
    .cell { position: relative; }
    .star {
      position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      background: rgba(0,0,0,.6); color: #fff; font: 16px/1 Arial, sans-serif; cursor: pointer; opacity: 0;
    }
    .cell:hover .star, .star:focus-visible, .star[aria-pressed="true"] { opacity: 1; }
    .star[aria-pressed="true"] { color: #ffd45c; }
    .tabs,.moods {display:flex;gap:6px;padding:6px 8px;flex:none;flex-wrap:wrap;}
    .tabs button,.moods button,.more {border:0;border-radius:16px;padding:7px 10px;background:var(--field);color:var(--fg);font:inherit;cursor:pointer;}
    .tabs button[aria-pressed="true"] {background:var(--accent);color:var(--bg);}
    .more {margin:4px 8px 8px;flex:none;}
    .attribution {display:block;text-align:center;padding:5px 8px 8px;color:var(--muted);font-size:11px;flex:none;text-decoration:none;}
    [hidden] {display:none!important;}
    button:focus-visible {outline:2px solid var(--accent);outline-offset:1px;}
  `;

  // ---------------------------------------------------------------- page hook

  const fromMain = new Map(); // nonce -> callback(msg)

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.gcfy !== "to-content" || typeof msg.nonce !== "string")
      return;
    const cb = fromMain.get(msg.nonce);
    if (cb) cb(msg);
  });

  const toMain = (msg) =>
    window.postMessage({ gcfy: "to-main", ...msg }, location.origin);

  function newNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ------------------------------------------------------------- GIF buttons

  function addButton(box) {
    if (box.querySelector(".gcfy-btn")) return;
    if (box.querySelector("#gif-button, [data-gif-picker]")) return;
    if (box.data?.isEdit || box.getAttribute("is-edit") === "true") return;
    if (!box.closest(BOX_SCOPE) || box.closest(POST_DIALOG)) return;
    const footer = box.querySelector("#footer");
    if (!footer) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gcfy-btn";
    btn.title = t("Add a GIF");
    btn.setAttribute("aria-label", t("Add a GIF"));
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (picker.open && picker.anchor === btn) closePicker();
      else openPicker(btn, box);
    });
    const emoji = footer.querySelector("#emoji-button");
    if (emoji && emoji.parentElement === footer) emoji.after(btn);
    else footer.prepend(btn);
  }

  // Inspect changed comment regions, not every node on every frame.
  const regions = new Set();
  let scanQueued = false;
  function scan() {
    scanQueued = false;
    for (const region of regions) {
      if (!region.isConnected) continue;
      if (region.matches?.("ytd-commentbox")) addButton(region);
      for (const box of region.querySelectorAll?.("ytd-commentbox") || [])
        addButton(box);
      foldImages(region);
    }
    regions.clear();
    if (picker.open && !picker.anchor.isConnected) closePicker();
    for (const [box, att] of attachments)
      if (!box.isConnected && !att.posting) detach(box, false);
  }
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.target.closest?.(".gcfy-attachment, .gcfy-fold-control"))
        continue;
      const box = record.target.closest?.("ytd-commentbox");
      if (box) regions.add(box);
      for (const node of record.addedNodes)
        if (node.nodeType === 1) regions.add(node);
    }
    if (!scanQueued) {
      scanQueued = true;
      requestAnimationFrame(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  regions.add(document.documentElement);
  requestAnimationFrame(scan);

  // ------------------------------------------------------------------ picker

  const picker = {
    open: false,
    host: null,
    anchor: null,
    box: null,
    els: null,
    seq: 0,
    timer: 0,
    gifs: [],
    nonce: null,
    favorites: [],
    showingFavorites: false,
    view: "search",
    recent: [],
    next: "",
    query: "",
    loading: false,
  };

  function buildPicker() {
    const host = document.createElement("div");
    // The picker is placed inside its comment box, so a click in it counts as
    // a click inside a reply dialog, which would otherwise close. A manual
    // popover still draws above the dialog, unclipped by its containers.
    host.setAttribute("popover", "manual");
    // Let the picker's own controls handle pointer events, then keep them from
    // YouTube's handlers. This must not check picker.open: picking a GIF
    // removes the picker while that same click is still bubbling.
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "contextmenu",
    ]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    const root = host.attachShadow({ mode: "open" });
    // A <style> element rather than adoptedStyleSheets: Firefox does not let a
    // content script assign constructed stylesheets to a page's shadow root.
    const style = document.createElement("style");
    style.textContent = PICKER_CSS;

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("Choose a GIF"));

    const search = document.createElement("div");
    search.className = "search";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("Search Tenor or paste a Tenor link");
    input.setAttribute("aria-label", t("Search Tenor or paste a Tenor link"));
    input.autocomplete = "off";
    input.spellcheck = false;
    const favTab = document.createElement("button");
    favTab.type = "button";
    favTab.className = "fav-tab";
    favTab.textContent = "★";
    favTab.title = t("Favorites");
    favTab.setAttribute("aria-label", t("Favorites"));
    favTab.setAttribute("aria-pressed", "false");
    search.append(input);

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");

    const grid = document.createElement("div");
    grid.className = "grid";

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    const recentTab = document.createElement("button");
    recentTab.type = "button";
    recentTab.textContent = t("Recent");
    const searchTab = document.createElement("button");
    searchTab.type = "button";
    searchTab.textContent = t("Search");
    const favoritesTab = document.createElement("button");
    favoritesTab.type = "button";
    favoritesTab.textContent = t("Favorites");
    tabs.append(searchTab, recentTab, favoritesTab);
    const moods = document.createElement("div");
    moods.className = "moods";
    for (const [en, ru, query] of [
      ["Laugh", "Смех", "laugh"],
      ["Thanks", "Спасибо", "thank you"],
      ["Wow", "Ого", "wow"],
      ["Approve", "Одобряю", "thumbs up"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = GCFY.ru ? ru : en;
      button.addEventListener("click", () => {
        input.value = query;
        clearTimeout(picker.timer);
        load(query);
      });
      moods.append(button);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = t("Load more");
    more.hidden = true;
    more.addEventListener("click", () => load(input.value, true));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "more";
    retry.textContent = t("Retry search");
    retry.hidden = true;
    retry.addEventListener("click", () => load(input.value));
    searchTab.addEventListener("click", () => load(input.value));
    recentTab.addEventListener("click", () => showLibrary("recent"));
    favoritesTab.addEventListener("click", () => showLibrary("favorites"));
    const attribution = document.createElement("a");
    attribution.className = "attribution";
    attribution.textContent = "GIFs via Tenor";
    attribution.href = "https://tenor.com/";
    attribution.target = "_blank";
    attribution.rel = "noopener noreferrer";
    panel.append(search, tabs, moods, status, grid, more, retry, attribution);
    root.append(style, panel);

    input.addEventListener("input", () => {
      picker.seq++;
      picker.loading = false;
      picker.els.more.hidden = true;
      clearTimeout(picker.timer);
      picker.timer = setTimeout(() => load(input.value), SEARCH_DEBOUNCE_MS);
    });
    favTab.addEventListener("click", () => {
      if (picker.showingFavorites) {
        load(input.value);
        return;
      }
      // A search that is waiting or under way must not replace the favorites.
      clearTimeout(picker.timer);
      picker.seq++;
      showLibrary("favorites");
    });
    grid.addEventListener("click", (e) => {
      const star = e.target.closest(".star");
      const tile = e.target.closest(".tile");
      if (star) toggleFavorite(picker.gifs[Number(star.dataset.index)]);
      else if (tile) attach(picker.gifs[Number(tile.dataset.index)]);
    });

    picker.host = host;
    picker.els = {
      panel,
      input,
      status,
      grid,
      favTab,
      recentTab,
      searchTab,
      favoritesTab,
      more,
      retry,
    };
  }

  function setStatus(text, kind) {
    picker.els.status.textContent = t(text || "");
    if (kind) picker.els.status.dataset.kind = kind;
    else delete picker.els.status.dataset.kind;
  }

  function place() {
    if (!picker.open) return;
    if (!picker.anchor.isConnected) {
      closePicker();
      return;
    }
    const r = picker.anchor.getBoundingClientRect();
    const h = Math.max(120, Math.min(PICKER_H, innerHeight - 16));
    const width = Math.min(PICKER_W, innerWidth - 16);
    picker.els.panel.style.height = `${h}px`;
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
    const left = Math.min(Math.max(8, r.left), innerWidth - width - 8);
    picker.host.style.top = `${Math.max(8, top)}px`;
    picker.host.style.left = `${Math.max(8, left)}px`;
  }

  function openPicker(anchor, box) {
    if (!picker.host) buildPicker();
    if (picker.open) closePicker();
    picker.open = true;
    picker.anchor = anchor;
    picker.box = box;
    anchor.setAttribute("aria-expanded", "true");
    picker.els.panel.toggleAttribute(
      "data-dark",
      document.documentElement.hasAttribute("dark"),
    );
    box.append(picker.host);
    if (picker.host.showPopover) picker.host.showPopover();
    place();
    picker.els.input.focus();
    if (picker.view === "recent" || picker.view === "favorites")
      showLibrary(picker.view);
    else load(picker.els.input.value);
  }

  function closePicker() {
    if (!picker.open) return;
    picker.open = false;
    clearTimeout(picker.timer);
    picker.seq++;
    picker.anchor.setAttribute("aria-expanded", "false");
    if (picker.host.hidePopover) picker.host.hidePopover();
    picker.host.remove();
    picker.loading = false;
    if (picker.anchor.isConnected) picker.anchor.focus();
  }

  const looksLikeLink = (text) =>
    /^\d{6,20}$/.test(text) ||
    /^(https?:\/\/)?([\w-]+\.)*tenor\.com\//i.test(text);

  async function load(raw, append = false) {
    if (
      append &&
      (picker.loading || !picker.next || picker.query !== raw.trim())
    )
      return;
    clearTimeout(picker.timer);
    const text = raw.trim(),
      seq = ++picker.seq;
    picker.loading = true;
    picker.view = "search";
    picker.query = text;
    setFavoritesView(false);
    updateTabs();
    picker.els.more.hidden = true;
    picker.els.retry.hidden = true;
    if (!append) render([]);
    setStatus(text ? "Searching…" : "Loading…");
    let reply;
    const options = {
      pos: append ? picker.next : "",
      locale: GCFY.ru ? "ru_RU" : "en_US",
    };
    try {
      reply = await chrome.runtime.sendMessage(
        !text
          ? { type: "featured", ...options }
          : looksLikeLink(text)
            ? { type: "resolve", input: text }
            : { type: "search", query: text, ...options },
      );
    } catch {
      reply = {
        ok: false,
        error: "The extension was reloaded. Refresh this page.",
      };
    }
    if (seq !== picker.seq || !picker.open) return;
    picker.loading = false;
    if (!reply?.ok) {
      setStatus(reply?.error || "Tenor could not be reached.", "error");
      picker.els.retry.hidden = false;
      return;
    }
    const top = picker.els.grid.scrollTop;
    render(
      GCFY.list(
        append ? [...picker.gifs, ...(reply.gifs || [])] : reply.gifs,
        300,
      ),
    );
    if (append) picker.els.grid.scrollTop = top;
    picker.next =
      picker.gifs.length >= 300 || (append && reply.next === options.pos)
        ? ""
        : reply.next || "";
    picker.els.more.hidden = !picker.next;
    setStatus(
      !picker.gifs.length
        ? "No GIFs found."
        : reply.degraded
          ? "Unverified results; availability is checked before posting."
          : "",
    );
  }
  function updateTabs() {
    for (const [button, view] of [
      [picker.els.searchTab, "search"],
      [picker.els.recentTab, "recent"],
      [picker.els.favoritesTab, "favorites"],
    ])
      button.setAttribute("aria-pressed", String(picker.view === view));
  }
  function showLibrary(view) {
    clearTimeout(picker.timer);
    picker.seq++;
    picker.loading = false;
    picker.view = view;
    setFavoritesView(view === "favorites");
    updateTabs();
    picker.next = "";
    picker.els.more.hidden = true;
    picker.els.retry.hidden = true;
    render(view === "favorites" ? picker.favorites : picker.recent);
    setStatus(
      picker.gifs.length
        ? ""
        : view === "favorites"
          ? NO_FAVORITES
          : "No recent GIFs yet.",
    );
  }

  function render(gifs) {
    picker.gifs = GCFY.list(gifs);
    gifs = picker.gifs;
    // Two columns that grow downwards; each GIF goes into the shorter one.
    const cols = [0, 1].map(() => {
      const col = document.createElement("div");
      col.className = "col";
      return { el: col, height: 0 };
    });
    gifs.forEach((gif, i) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.dataset.index = String(i);
      tile.title = gif.title;
      const img = document.createElement("img");
      img.src = gif.preview;
      img.alt = gif.title;
      img.width = gif.width;
      img.height = gif.height;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener(
        "error",
        () => {
          tile.disabled = true;
          img.remove();
          tile.textContent = t("Preview unavailable");
        },
        { once: true },
      );
      img.referrerPolicy = "no-referrer";
      tile.append(img);
      const star = document.createElement("button");
      star.type = "button";
      star.className = "star";
      star.dataset.index = String(i);
      setStar(star, gif);
      cell.append(tile, star);
      const col = cols[0].height <= cols[1].height ? cols[0] : cols[1];
      col.el.append(cell);
      col.height += gif.height / gif.width;
    });
    picker.els.grid.replaceChildren(...cols.map((c) => c.el));
    picker.els.grid.scrollTop = 0;
  }

  // --------------------------------------------------------------- favorites

  function setFavoritesView(on) {
    picker.showingFavorites = on;
    picker.els.favTab.setAttribute("aria-pressed", String(on));
  }

  function setStar(star, gif) {
    const on = picker.favorites.some((f) => f.id === gif.id);
    star.textContent = on ? "★" : "☆";
    star.title = t(on ? "Remove from favorites" : "Add to favorites");
    star.setAttribute("aria-label", star.title);
    star.setAttribute("aria-pressed", String(on));
  }

  function renderFavorites(keepScroll) {
    const top = keepScroll ? picker.els.grid.scrollTop : 0;
    render(picker.favorites);
    picker.els.grid.scrollTop = top;
    setStatus(picker.favorites.length ? "" : NO_FAVORITES);
  }

  // Takes the stored list, on load and whenever any tab changes it, so every
  // tab works on the same list and none writes back an old copy.
  function useFavorites(stored) {
    picker.favorites = GCFY.list(stored);
    if (!picker.open) return;
    if (picker.showingFavorites) renderFavorites(true);
    else
      for (const star of picker.els.grid.querySelectorAll(".star"))
        setStar(star, picker.gifs[Number(star.dataset.index)]);
  }

  chrome.storage.local
    .get(["favorites", "recent", "settings"])
    .then((items) => {
      useFavorites(items.favorites);
      picker.recent = GCFY.list(items.recent, 30);
      applySettings(items.settings);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.favorites) useFavorites(changes.favorites.newValue);
    if (changes.recent) {
      picker.recent = GCFY.list(changes.recent.newValue, 30);
      if (picker.open && picker.view === "recent") showLibrary("recent");
    }
    if (changes.settings) applySettings(changes.settings.newValue);
  });

  // Only writes the list; the change listener above then shows it, here and
  // in every other tab.
  async function toggleFavorite(gif) {
    if (!gif) return;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "library:toggle",
        gif,
      });
      if (!result?.ok) throw new Error(result?.error);
      useFavorites(result.favorites);
    } catch (e) {
      setStatus(
        e.message || "The favorite could not be saved. Refresh this page.",
        "error",
      );
    }
  }

  // ----------------------------------------------------------------- posting

  function selectRange(editor, range) {
    editor.focus();
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Adds the marker after whatever the user has typed, leaving their text
  // (and any emoji or mentions in it) as it is.
  function appendMarker(editor, marker) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selectRange(editor, range);
    let done = false;
    try {
      done = document.execCommand("insertText", false, marker);
    } catch (e) {
      /* fall back below */
    }
    if (!done || !editor.textContent.includes(marker)) {
      editor.append(document.createTextNode(marker));
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: marker,
        }),
      );
    }
  }

  function removeMarker(editor, marker) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(marker);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + marker.length);
      selectRange(editor, range);
      let done = false;
      try {
        done = document.execCommand("delete", false);
      } catch (e) {
        /* fall back below */
      }
      if (!done || editor.textContent.includes(marker)) {
        node.data = node.data.replace(marker, "");
        editor.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
          }),
        );
      }
      return;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------------------- attachments

  // Picking a GIF only attaches it to its comment box. The marker is added when
  // the user presses YouTube's Comment button, so they can keep editing their
  // text until then.
  const attachments = new Map(); // ytd-commentbox -> { gif, chip, status, observer, posting }
  let passThrough = false;

  // YouTube greys its Comment button out by swapping its style class for a
  // disabled one: [disabled, enabled], current and older class names.
  const BUTTON_STYLES = [
    ["ytSpecButtonShapeNextDisabled", "ytSpecButtonShapeNextMono"],
    ["yt-spec-button-shape-next--disabled", "yt-spec-button-shape-next--mono"],
  ];
  const submitOf = (box) => box.querySelector("#submit-button button");
  const editorOf = (box) => box.querySelector("#contenteditable-root");

  function attach(gif) {
    const box = picker.box;
    const footer = box && box.isConnected && box.querySelector("#footer");
    const editor = footer && editorOf(box);
    if (!editor) {
      setStatus("The comment box was closed. Open it and try again.", "error");
      return;
    }
    gif = GCFY.validGif(gif);
    if (!gif) return;
    const old = attachments.get(box);
    if (old && (old.posting || old.uncertain)) return;
    detach(box, false);

    const chip = document.createElement("div");
    chip.className = "gcfy-attachment";
    const frame = document.createElement("div");
    frame.className = "gcfy-attachment-gif";
    const img = document.createElement("img");
    img.src = gif.preview;
    img.alt = gif.title;
    img.width = gif.width;
    img.height = gif.height;
    img.referrerPolicy = "no-referrer";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "gcfy-attachment-remove";
    remove.textContent = "×";
    remove.title = t("Remove the GIF");
    remove.setAttribute("aria-label", t("Remove the GIF"));
    remove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!att.posting) detach(box, true);
    });
    frame.append(img, remove);
    const status = document.createElement("div");
    status.className = "gcfy-attachment-status";
    status.setAttribute("role", "status");
    chip.append(frame, status);
    footer.before(chip);

    // YouTube disables its Comment button while the text is empty; a comment
    // that is only a GIF must still be postable.
    const observer = new MutationObserver(() => enableSubmit(box));
    const att = {
      gif,
      chip,
      status,
      observer,
      posting: false,
      uncertain: false,
      greyed: [],
    };
    attachments.set(box, att);
    const submit = submitOf(box);
    if (submit)
      observer.observe(submit, {
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "class"],
      });
    enableSubmit(box);

    closePicker();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selectRange(editor, range);
  }

  function enableSubmit(box) {
    const submit = submitOf(box);
    const att = attachments.get(box);
    // Only a GIF with no text needs this. Once there is text, YouTube's own
    // checks and its sending state decide whether the button is usable.
    if (!submit || !att || att.posting || editorOf(box)?.textContent.trim())
      return;
    if (submit.disabled) submit.disabled = false;
    if (submit.hasAttribute("aria-disabled"))
      submit.removeAttribute("aria-disabled");
    for (const style of BUTTON_STYLES) {
      if (!submit.classList.contains(style[0])) continue;
      submit.classList.replace(style[0], style[1]);
      if (!att.greyed.includes(style)) att.greyed.push(style);
    }
  }

  function detach(box, restoreSubmit) {
    const att = attachments.get(box);
    if (!att) return;
    attachments.delete(box);
    att.observer.disconnect();
    att.chip.remove();
    const submit = submitOf(box);
    const editor = editorOf(box);
    if (restoreSubmit && submit && editor && !editor.textContent.trim()) {
      submit.disabled = true;
      for (const [disabled, enabled] of att.greyed)
        submit.classList.replace(enabled, disabled);
    }
  }

  function setChipStatus(att, text, kind) {
    att.status.textContent = t(text || "");
    if (kind) att.status.dataset.kind = kind;
    else delete att.status.dataset.kind;
  }

  async function post(box) {
    const att = attachments.get(box);
    const editor = editorOf(box);
    const submit = submitOf(box);
    if (!att || att.posting || !editor || !submit) return;
    if (att.uncertain) {
      showUncertain(att);
      return;
    }
    let snapshot, originalText;
    const videoId =
      new URL(location.href).searchParams.get("v") ||
      location.pathname.match(/\/shorts\/([\w-]{11})/)?.[1];
    const draftKey = att.draftKey || (att.draftKey = newNonce());

    const nonce = newNonce();
    const marker = `[[gif:${att.gif.id}:${nonce}]]`;
    let settle;
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    let armedAck;
    const armedPromise = new Promise((resolve) => {
      armedAck = resolve;
    });
    let seen = false;
    fromMain.set(nonce, (msg) => {
      if (msg.type === "armed") armedAck(true);
      else if (msg.type === "refused") armedAck("refused");
      else if (msg.type === "seen") seen = true;
      else if (msg.type === "result") settle(msg);
    });

    att.posting = true;
    att.chip.toggleAttribute("data-busy", true);
    setChipStatus(att, "Posting…");
    try {
      // Unrated favorites and fallback results must be checked first.
      let rating = att.gif.contentRating;
      if (
        rating !== "G" ||
        !att.gif.verifiedAt ||
        Date.now() - att.gif.verifiedAt > 600000
      ) {
        setChipStatus(att, "Checking the GIF…");
        const checked = await Promise.race([
          chrome.runtime
            .sendMessage({ type: "check", id: att.gif.id })
            .catch(() => null),
          sleep(CHECK_TIMEOUT_MS).then(() => null),
        ]);
        const found =
          checked &&
          checked.ok &&
          Array.isArray(checked.gifs) &&
          checked.gifs.find((g) => g.id === att.gif.id);
        rating = found ? found.contentRating : null;
        if (!found || rating !== "G") {
          setChipStatus(
            att,
            found && rating
              ? "This GIF is not eligible. Choose another."
              : "Could not verify this GIF. Try again later.",
            "error",
          );
          return;
        }
        att.gif.contentRating = rating;
        att.gif.verifiedAt = Date.now();
        // A reply dialog can be closed while Tenor answers.
        if (!box.isConnected || !editor.getClientRects().length) {
          setChipStatus(
            att,
            "The comment box was closed. Open it and try again.",
            "error",
          );
          return;
        }
        setChipStatus(att, "Posting…");
      }
      toMain({ type: "arm", id: att.gif.id, ratedG: rating === "G", nonce });
      // Without the page hook the marker would be posted as plain text, so
      // nothing is typed into the box until the hook has answered.
      const armed = await Promise.race([
        armedPromise,
        sleep(ARM_TIMEOUT_MS).then(() => false),
      ]);
      if (armed !== true) {
        setChipStatus(
          att,
          armed === "refused"
            ? "Not ready in this tab yet. Try again in a few seconds, or refresh this page."
            : "The page hook is not running. Refresh this page and try again.",
          "error",
        );
        return;
      }
      if (!box.isConnected || !editor.getClientRects().length) {
        toMain({ type: "disarm", nonce });
        setChipStatus(
          att,
          "The comment box was closed. Open it and try again.",
          "error",
        );
        return;
      }

      snapshot = [...editor.childNodes].map((node) => node.cloneNode(true));
      originalText = editor.textContent;
      if (videoId)
        chrome.runtime
          .sendMessage({
            type: "library:recover",
            draft: { key: draftKey, videoId, text: originalText, gif: att.gif },
          })
          .catch(() => {});
      appendMarker(editor, marker);
      if (!editor.textContent.endsWith(marker))
        throw new Error(
          "The request could not be read safely. Refresh this page.",
        );
      for (let i = 0; i < 20 && submit.disabled; i++) await sleep(50);
      passThrough = true;
      try {
        submit.click();
      } finally {
        passThrough = false;
      }

      let result = await Promise.race([
        settled,
        sleep(SUBMIT_GRACE_MS).then(() => null),
      ]);
      if (!result && seen)
        result = await Promise.race([
          settled,
          sleep(RESULT_TIMEOUT_MS).then(() => null),
        ]);

      if (result && result.ok) {
        chrome.runtime
          .sendMessage({ type: "library:recent", gif: att.gif })
          .catch(() => {});
        chrome.runtime
          .sendMessage({ type: "library:forgetDraft", key: draftKey })
          .catch(() => {});
        detach(box, false);
        return;
      }
      // Failed or never sent: take the marker back out of the box.
      toMain({ type: "disarm", nonce });
      if (editor.isConnected) removeMarker(editor, marker);
      if (
        editor.isConnected &&
        !editor.textContent.trim() &&
        originalText?.trim()
      ) {
        editor.replaceChildren(...snapshot.map((node) => node.cloneNode(true)));
        editor.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: originalText,
          }),
        );
      }
      if ((result && result.kind === "uncertain") || (!result && seen)) {
        att.uncertain = true;
        showUncertain(att);
      } else
        setChipStatus(
          att,
          result
            ? resultText(result)
            : "The GIF was not sent. Nothing was posted.",
          "error",
        );
    } catch (error) {
      if (seen) {
        att.uncertain = true;
        showUncertain(att);
      } else
        setChipStatus(
          att,
          error.message ||
            "The request could not be read safely. Refresh this page.",
          "error",
        );
    } finally {
      toMain({ type: "disarm", nonce });
      if (editor.isConnected && editor.textContent.includes(marker))
        removeMarker(editor, marker);
      fromMain.delete(nonce);
      att.posting = false;
      att.chip.toggleAttribute("data-busy", false);
      enableSubmit(box);
      if (!box.isConnected) detach(box, false);
    }
  }

  function showUncertain(att) {
    setChipStatus(att, "Check the comments before trying again.", "error");
    const allow = document.createElement("button");
    allow.type = "button";
    allow.textContent = t("I checked; allow retry");
    allow.addEventListener("click", () => {
      att.uncertain = false;
      setChipStatus(att, "Draft saved");
    });
    att.status.append(document.createElement("br"), allow);
  }

  let hideGifs = false;
  const folded = new Map();
  function applySettings(settings) {
    hideGifs = settings?.hideGifs === true;
    for (const [img, control] of folded) {
      if (!img.isConnected) {
        control.remove();
        folded.delete(img);
        continue;
      }
      img.classList.toggle("gcfy-folded", hideGifs);
      control.hidden = !hideGifs;
    }
    if (hideGifs) foldImages(document.documentElement);
  }
  function foldImages(region) {
    for (const [img, control] of folded)
      if (!img.isConnected) {
        control.remove();
        folded.delete(img);
      }
    if (!hideGifs) return;
    const candidates = [
      ...(region.matches?.("img") ? [region] : []),
      ...(region.querySelectorAll?.("img") || []),
    ];
    for (const img of candidates) {
      if (
        folded.has(img) ||
        img.closest(".gcfy-attachment") ||
        !img.closest("ytd-comment-view-model, ytd-comment-renderer")
      )
        continue;
      let url;
      try {
        url = new URL(img.currentSrc || img.src);
      } catch {
        continue;
      }
      if (!/^media\d*\.tenor\.com$/.test(url.hostname)) continue;
      const control = document.createElement("button");
      control.type = "button";
      control.className = "gcfy-fold-control";
      control.textContent = t("GIF hidden") + " · " + t("Show");
      control.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const hidden = img.classList.toggle("gcfy-folded");
        control.textContent = hidden
          ? t("GIF hidden") + " · " + t("Show")
          : t("Hide");
      });
      img.before(control);
      img.classList.add("gcfy-folded");
      folded.set(img, control);
    }
  }

  const boxIn = (path) => path.find((n) => n.localName === "ytd-commentbox");

  // Capture phase on window, ahead of YouTube's own handlers: pressing Comment
  // in a box with a GIF attached posts the GIF instead.
  window.addEventListener(
    "click",
    (e) => {
      if (passThrough) return;
      const path = e.composedPath();
      const box = boxIn(path);
      if (!box || !attachments.has(box)) return;
      const submit = box.querySelector("#submit-button");
      const cancel = box.querySelector("#cancel-button");
      if (submit && path.includes(submit)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        post(box);
      } else if (
        cancel &&
        path.includes(cancel) &&
        !attachments.get(box).posting
      ) {
        detach(box, false);
      }
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (e) => {
      // The picker sits inside the comment box; Ctrl+Enter in its search field
      // must not post the GIF already attached to that box.
      if (inPicker(e)) return;
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
      const box = boxIn(e.composedPath());
      if (!box || !attachments.has(box)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post(box);
    },
    true,
  );

  // ------------------------------------------------------- page interactions

  const inPicker = (e) => picker.open && e.composedPath().includes(picker.host);

  // Registered at document_start in the capture phase, ahead of YouTube's own
  // handlers, so typing in the search field does not trigger player shortcuts
  // and scrolling the grid does not flip to the next Short.
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!inPicker(e)) return;
        e.stopImmediatePropagation();
        if (type !== "keydown") return;
        if (
          e.key.startsWith("Arrow") &&
          e.composedPath()[0] !== picker.els.input
        ) {
          const buttons = [...picker.els.grid.querySelectorAll(".tile")];
          const index = buttons.indexOf(e.composedPath()[0]);
          if (index >= 0) {
            e.preventDefault();
            buttons[
              (index +
                (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) +
                buttons.length) %
                buttons.length
            ]?.focus();
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePicker();
        } else if (
          e.key === "Enter" &&
          e.composedPath()[0] === picker.els.input &&
          picker.gifs.length === 1
        ) {
          e.preventDefault();
          attach(picker.gifs[0]);
        }
      },
      true,
    );
  }
  window.addEventListener(
    "wheel",
    (e) => {
      if (inPicker(e)) e.stopImmediatePropagation();
    },
    { capture: true, passive: true },
  );

  window.addEventListener(
    "pointerdown",
    (e) => {
      if (!picker.open) return;
      const path = e.composedPath();
      if (!path.includes(picker.host) && !path.includes(picker.anchor))
        closePicker();
    },
    true,
  );

  let placeQueued = false;
  const queuePlace = () => {
    if (!picker.open || placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  };
  window.addEventListener("scroll", queuePlace, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", queuePlace, { passive: true });
  window.addEventListener("yt-navigate-start", () => {
    closePicker();
    for (const [box, att] of attachments) if (!att.posting) detach(box, false);
  });
})();
