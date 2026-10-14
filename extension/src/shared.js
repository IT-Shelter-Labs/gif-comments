(() => {
  if (globalThis.GCFY) return;
  const ru = String(globalThis.navigator?.language || "en")
    .toLowerCase()
    .startsWith("ru");
  const strings = {
    "Add a GIF": "Добавить GIF",
    "Choose a GIF": "Выбрать GIF",
    "Search Tenor or paste a Tenor link": "Поиск или ссылка Tenor",
    Favorites: "Избранное",
    Recent: "Недавние",
    Search: "Поиск",
    "Remove from favorites": "Убрать из избранного",
    "Add to favorites": "В избранное",
    "No favorites yet. Point at a GIF and click its star.":
      "Нажмите звёздочку на GIF, чтобы сохранить её.",
    "No recent GIFs yet.": "Здесь появятся успешно отправленные GIF.",
    "Searching…": "Ищем…",
    "Loading…": "Загружаем…",
    "Posting…": "Отправляем…",
    "Checking the GIF…": "Проверяем GIF…",
    "No GIFs found.": "Ничего не найдено.",
    "Remove the GIF": "Убрать GIF",
    "Load more": "Показать ещё",
    "Retry search": "Повторить поиск",
    "The comment box was closed. Open it and try again.":
      "Поле комментария закрыто. Откройте его снова.",
    "The extension was reloaded. Refresh this page.":
      "Расширение обновлено. Обновите страницу.",
    "Tenor could not be reached.": "Tenor недоступен. Попробуйте позже.",
    "The favorite could not be saved. Refresh this page.":
      "Не удалось сохранить GIF. Обновите страницу.",
    "The page hook is not running. Refresh this page and try again.":
      "Обновите страницу перед отправкой GIF.",
    "Not ready in this tab yet. Try again in a few seconds, or refresh this page.":
      "Другая отправка ещё выполняется или вкладка не готова. Подождите либо обновите страницу.",
    "The GIF was not sent. Nothing was posted.":
      "Запрос GIF не был отправлен. Черновик сохранён.",
    "Check the comments before trying again.":
      "Результат неизвестен. Проверьте комментарии перед повтором.",
    "I checked; allow retry": "Я проверил — разрешить повтор",
    "Could not verify this GIF. Try again later.":
      "Не удалось проверить GIF. Попробуйте позже.",
    "This GIF is not eligible. Choose another.":
      "Эта GIF не подходит. Выберите другую.",
    "YouTube rejected the comment.": "YouTube отклонил комментарий.",
    "This operation does not support GIFs.":
      "В этой форме нельзя отправить GIF.",
    "The request could not be read safely. Refresh this page.":
      "Не удалось безопасно обработать запрос. Обновите страницу.",
    "GIF hidden": "GIF скрыта",
    Show: "Показать",
    Hide: "Скрыть",
    "Unverified results; availability is checked before posting.":
      "Проверка доступности GIF выполнится перед отправкой.",
    "Preview unavailable": "Превью недоступно",
    "Draft saved": "Черновик сохранён",
    "GIF limit reached (300). Remove a favorite first.":
      "Лимит 300 GIF. Сначала удалите одну из избранного.",
  };
  const t = (text) => {
    if (!ru) return text;
    if (strings[text]) return strings[text];
    if (/^Tenor returned HTTP \d+\.$/.test(text))
      return text.replace("Tenor returned HTTP", "Tenor вернул HTTP");
    if (/Tenor changed its page format/.test(text))
      return "Формат Tenor изменился. Попробуйте позже.";
    if (/Tenor.*find that GIF|link does not point at a GIF/.test(text))
      return "GIF по этой ссылке не найдена.";
    if (/not a Tenor/.test(text))
      return "Нужна ссылка Tenor или числовой ID GIF.";
    if (/Tenor is busy/.test(text))
      return "Tenor перегружен. Попробуйте позже.";
    if (/timeout|timed out|aborted|Failed to fetch|NetworkError/i.test(text))
      return "Сервис не ответил. Попробуйте позже.";
    if (/YouTube only takes GIFs/.test(text))
      return "Эта GIF не подходит. Выберите другую.";
    return text;
  };
  const validGif = (g) => {
    if (!g || !/^\d{1,20}$/.test(String(g.id))) return null;
    let url;
    try {
      url = new URL(g.preview);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      !/^media\d*\.tenor\.com$/.test(url.hostname) ||
      url.username ||
      url.password
    )
      return null;
    const width = Number(g.width),
      height = Number(g.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 10000 ||
      height > 10000
    )
      return null;
    return {
      id: String(g.id),
      title: String(g.title || "GIF").slice(0, 200),
      preview: url.href,
      width,
      height,
      contentRating:
        typeof g.contentRating === "string"
          ? g.contentRating.slice(0, 10)
          : null,
      verifiedAt:
        Number.isFinite(g.verifiedAt) && g.verifiedAt <= Date.now()
          ? g.verifiedAt
          : 0,
    };
  };
  const list = (value, max = 300) => {
    const seen = new Set();
    return (Array.isArray(value) ? value : [])
      .map(validGif)
      .filter((g) => g && !seen.has(g.id) && seen.add(g.id))
      .slice(0, max);
  };
  const resultText = (result) => {
    const code = result?.code;
    const text =
      code === "unreadable"
        ? "The request could not be read safely. Refresh this page."
        : code === "unsupported"
          ? "This operation does not support GIFs."
          : code === "rejected"
            ? "YouTube rejected the comment."
            : "Check the comments before trying again.";
    return (
      t(text) +
      (code === "rejected" && result.message
        ? ` ${String(result.message).slice(0, 500)}`
        : "") +
      (code === "rejected" && result.httpStatus
        ? ` (HTTP ${result.httpStatus})`
        : "")
    );
  };
  globalThis.GCFY = { ru, t, validGif, list, resultText };
})();
