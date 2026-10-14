"use strict";
const $ = (id) => document.getElementById(id);
const lang = (ru, en) => (GCFY.ru ? ru : en);
function status(message) {
  $("status").textContent = message;
}
const labels = {
  subtitle: lang("GIF для комментариев YouTube", "GIFs for YouTube comments"),
  hideLabel: lang(
    "Сворачивать GIF в комментариях",
    "Collapse GIFs in comments",
  ),
  local: lang(
    "Избранное и история хранятся в браузере. Поисковые запросы и превью загружаются с Tenor.",
    "Favorites and history stay in this browser. Searches and previews load from Tenor.",
  ),
  libraryTitle: lang("Моя библиотека", "My library"),
  export: lang("Экспорт", "Export"),
  import: lang("Импорт", "Import"),
  clear: lang("Очистить недавние", "Clear recent"),
  draftTitle: lang("Восстановление черновиков", "Draft recovery"),
  draftHint: lang(
    "Резервные копии текста перед отправкой доступны 24 часа. Повторная отправка выполняется вручную.",
    "Text backups before posting are available for 24 hours. Reposting is manual.",
  ),
  clearDrafts: lang("Удалить черновики", "Delete drafts"),
  help: lang(
    "На YouTube откройте комментарий → GIF → выберите реакцию → отправьте. Ctrl/Cmd+Enter — отправить; Esc — закрыть выбор.",
    "On YouTube: open a comment → GIF → choose a reaction → post. Ctrl/Cmd+Enter posts; Esc closes the picker.",
  ),
};
for (const [id, label] of Object.entries(labels)) $(id).textContent = label;
let favorites = [];
async function refresh() {
  await chrome.runtime.sendMessage({ type: "library:get" });
  const stored = await chrome.storage.local.get([
    "favorites",
    "recent",
    "settings",
    "recovery",
  ]);
  favorites = GCFY.list(stored.favorites);
  $("hide").checked = stored.settings?.hideGifs === true;
  $("counts").textContent = lang(
    `Избранное: ${favorites.length} · Недавние: ${GCFY.list(stored.recent, 30).length}`,
    `Favorites: ${favorites.length} · Recent: ${GCFY.list(stored.recent, 30).length}`,
  );
  const drafts = (Array.isArray(stored.recovery) ? stored.recovery : [])
    .filter(
      (d) =>
        d?.time > Date.now() - 86400000 &&
        typeof d.text === "string" &&
        /^[\w-]{11}$/.test(d.videoId),
    )
    .slice(0, 10);
  $("drafts").replaceChildren();
  if (!drafts.length)
    $("drafts").textContent = lang(
      "Нет сохранённых черновиков.",
      "No saved drafts.",
    );
  for (const draft of drafts) {
    const div = document.createElement("div");
    div.className = "draft";
    const a = document.createElement("a");
    a.href = `https://www.youtube.com/watch?v=${draft.videoId}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = lang("Открыть видео", "Open video");
    const pre = document.createElement("pre");
    pre.textContent =
      draft.text || lang("Комментарий только с GIF", "GIF-only comment");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = lang("Скопировать текст", "Copy text");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(draft.text);
        status(lang("Текст скопирован.", "Text copied."));
      } catch {
        const selection = getSelection(),
          range = document.createRange();
        range.selectNodeContents(pre);
        selection.removeAllRanges();
        selection.addRange(range);
        status(
          lang(
            "Текст выделен. Нажмите Ctrl+C.",
            "Text selected. Press Ctrl+C.",
          ),
        );
      }
    });
    div.append(a, pre, copy);
    if (draft.gif?.id && /^\d{1,20}$/.test(draft.gif.id)) {
      const gif = document.createElement("a");
      gif.href = `https://tenor.com/view/x-gif-${draft.gif.id}`;
      gif.textContent = " · GIF";
      gif.target = "_blank";
      gif.rel = "noopener noreferrer";
      div.append(gif);
    }
    $("drafts").append(div);
  }
  $("clearDrafts").hidden = !drafts.length;
}
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "Unavailable");
  return result;
}
$("hide").addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({
      settings: { hideGifs: $("hide").checked },
    });
  } catch {
    status(lang("Не удалось сохранить настройку.", "Could not save settings."));
  }
});
$("export").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { format: "gif-comments-favorites", version: 1, gifs: favorites },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "gif-favorites.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  try {
    const file = $("file").files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error("Too large");
    const data = JSON.parse(await file.text());
    if (data.format !== "gif-comments-favorites" || data.version !== 1)
      throw new Error("Invalid");
    await send({ type: "library:import", gifs: data.gifs });
    await refresh();
    status(lang("Избранное импортировано.", "Favorites imported."));
  } catch {
    status(
      lang(
        "Не удалось импортировать. Выберите корректный файл экспорта GIF Comments размером до 1 МБ.",
        "Import failed. Choose a valid GIF Comments export up to 1 MB.",
      ),
    );
  } finally {
    $("file").value = "";
  }
});
$("clear").addEventListener("click", async () => {
  try {
    await send({ type: "library:clearRecent" });
    await refresh();
    status(lang("История очищена.", "History cleared."));
  } catch {
    status(lang("Не удалось очистить историю.", "Could not clear history."));
  }
});
$("clearDrafts").addEventListener("click", async () => {
  try {
    await send({ type: "library:clearDrafts" });
    await refresh();
  } catch {
    status(lang("Не удалось удалить черновики.", "Could not delete drafts."));
  }
});
refresh().catch(() =>
  status(
    lang(
      "Не удалось прочитать данные расширения.",
      "Could not read extension data.",
    ),
  ),
);
