// Authentication and signing remain with YouTube's own page.
(() => {
  const LOADED = Symbol.for("gcfy.hook");
  if (window[LOADED]) return;
  window[LOADED] = true;
  const MARKER = /\[\[gif:(\d{1,20}):([a-z0-9]{8,32})\]\]/;
  const CREATE = /^\/youtubei\/v1\/comment\/create_comment(?:_reply)?$/;
  const WATCHED = /^\/youtubei\/v1\/(?:comment|backstage)\//;
  const armed = new Map(),
    consumed = new Map();
  const nativeFetch = window.fetch;
  let live = document.readyState === "loading";
  const emit = (message) =>
    window.postMessage({ gcfy: "to-content", ...message }, location.origin);
  const prune = () => {
    for (const [nonce, entry] of armed)
      if (entry.expires < Date.now()) armed.delete(nonce);
    for (const [nonce, expires] of consumed)
      if (expires < Date.now()) consumed.delete(nonce);
  };
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.gcfy !== "to-main") return;
    prune();
    if (
      message.type === "arm" &&
      /^\d{1,20}$/.test(message.id) &&
      /^[a-z0-9]{8,32}$/.test(message.nonce)
    ) {
      if (!live || armed.size || consumed.has(message.nonce)) {
        emit({ type: "refused", nonce: message.nonce });
        return;
      }
      armed.set(message.nonce, { id: message.id, expires: Date.now() + 15000 });
      emit({ type: "armed", nonce: message.nonce });
    } else if (message.type === "disarm") armed.delete(message.nonce);
  });
  async function read(input, init) {
    const request = input instanceof Request;
    const headers = new Headers(
      init?.headers ?? (request ? input.headers : {}),
    );
    let buffer;
    if (init?.body != null)
      buffer = await new Response(init.body).arrayBuffer();
    else if (request) buffer = await input.clone().arrayBuffer();
    else return null;
    const encoding = (headers.get("content-encoding") || "").toLowerCase();
    if (encoding && encoding !== "gzip" && encoding !== "identity")
      throw new Error("Unsupported encoding");
    const text =
      encoding === "gzip"
        ? await new Response(
            new Blob([buffer])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).text()
        : new TextDecoder().decode(buffer);
    return { text, headers };
  }
  window.fetch = function (input, init) {
    let url;
    try {
      url = new URL(
        input instanceof Request ? input.url : String(input),
        location.origin,
      );
    } catch {
      return nativeFetch.apply(this, arguments);
    }
    if (url.origin !== location.origin)
      return nativeFetch.apply(this, arguments);
    if (url.pathname.startsWith("/youtubei/v1/")) live = true;
    if (!WATCHED.test(url.pathname)) return nativeFetch.apply(this, arguments);
    return intercept.call(this, url, input, init, arguments);
  };
  async function intercept(url, input, init, args) {
    prune();
    let parsed;
    try {
      parsed = await read(input, init);
    } catch {
      // While armed, unreadable comment bodies cannot safely pass unchanged.
      if (armed.size) {
        for (const nonce of armed.keys())
          emit({
            type: "result",
            nonce,
            ok: false,
            kind: "rejected",
            code: "unreadable",
          });
        armed.clear();
        throw new TypeError("GIF request could not be read safely");
      }
      return nativeFetch.apply(this, args);
    }
    const match = parsed?.text.match(MARKER);
    if (!match) return nativeFetch.apply(this, args);
    const [marker, id, nonce] = match;
    const entry = armed.get(nonce);
    armed.delete(nonce);
    let body;
    try {
      body = JSON.parse(parsed.text);
    } catch {
      /* blocked below */
    }
    const text = typeof body?.commentText === "string" ? body.commentText : "";
    const suffix = text.trimEnd();
    const ownText = suffix.endsWith(marker)
      ? suffix.slice(0, -marker.length)
      : null;
    const method = String(
      init?.method ?? (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    if (
      method !== "POST" ||
      !CREATE.test(url.pathname) ||
      ownText === null ||
      MARKER.test(ownText) ||
      !entry ||
      entry.id !== id ||
      consumed.has(nonce)
    ) {
      emit({
        type: "result",
        nonce,
        ok: false,
        kind: "rejected",
        code: "unsupported",
      });
      throw new TypeError("GIF marker blocked");
    }
    consumed.set(nonce, Date.now() + 180000);
    emit({ type: "seen", nonce });
    if (ownText.trim()) body.commentText = ownText;
    else delete body.commentText;
    body.tenorId = id;
    parsed.headers.delete("content-encoding");
    parsed.headers.delete("content-length");
    const payload = JSON.stringify(body);
    let response;
    try {
      response =
        input instanceof Request
          ? await nativeFetch.call(
              this,
              new Request(input, {
                ...init,
                body: payload,
                headers: parsed.headers,
              }),
            )
          : await nativeFetch.call(this, input, {
              ...init,
              body: payload,
              headers: parsed.headers,
            });
    } catch (error) {
      emit({
        type: "result",
        nonce,
        ok: false,
        kind: "uncertain",
        code: "uncertain",
      });
      throw error;
    }
    const verdict = await judge(response);
    // Publication is never retried automatically: no idempotency guarantee.
    emit({ type: "result", nonce, ...verdict });
    return response;
  }
  function textOf(value) {
    if (typeof value === "string") return value.slice(0, 500);
    if (!value || typeof value !== "object") return "";
    if (typeof value.simpleText === "string")
      return value.simpleText.slice(0, 500);
    if (typeof value.content === "string") return value.content.slice(0, 500);
    return Array.isArray(value.runs)
      ? value.runs
          .map((r) => (typeof r?.text === "string" ? r.text : ""))
          .join("")
          .slice(0, 500)
      : "";
  }
  function errors(actions, depth = 0) {
    if (!Array.isArray(actions) || depth > 8) return [];
    return actions.slice(0, 200).flatMap((a) => {
      if (!a || typeof a !== "object") return [];
      const error = a.showErrorAction?.errorMessage;
      return [
        ...(a.showErrorAction
          ? [textOf(error?.messageRenderer?.text) || textOf(error)]
          : []),
        ...errors(a.commandExecutorCommand?.commands, depth + 1),
      ];
    });
  }
  async function judge(response) {
    let json;
    try {
      json = await response.clone().json();
    } catch {
      /* uncertain */
    }
    const action = json?.actionResult;
    const failures = [
      ...errors(json?.actions),
      ...errors(json?.onResponseReceivedActions),
      ...errors(json?.onResponseReceivedEndpoints),
    ];
    const ok =
      response.ok && action?.status === "STATUS_SUCCEEDED" && !failures.length;
    const rejected =
      !ok &&
      ((response.status >= 400 && response.status < 500) ||
        failures.length ||
        action?.status === "STATUS_FAILED");
    return {
      ok: !!ok,
      kind: ok ? "posted" : rejected ? "rejected" : "uncertain",
      code: ok ? null : rejected ? "rejected" : "uncertain",
      httpStatus: response.status,
      message: rejected
        ? [
            textOf(json?.error?.message),
            ...failures,
            textOf(action?.feedbackText),
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 500)
        : "",
    };
  }
})();
