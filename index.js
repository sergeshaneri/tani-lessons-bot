const fs = require("node:fs");
const path = require("node:path");

loadEnvFile(path.join(__dirname, ".env"));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";
const LOCAL_DATA_DIR = path.join(__dirname, "data");
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || LOCAL_DATA_DIR;
const DEFAULT_LESSONS_PATH = path.join(__dirname, "lessons.json");
const LESSONS_PATH = process.env.LESSONS_PATH || path.join(DATA_DIR, "lessons.json");
const PROGRESS_PATH = path.join(DATA_DIR, "progress.json");
const ADMIN_STATE_PATH = path.join(DATA_DIR, "admin-state.json");
const MEDIA_CAPTION_LIMIT = 1000;
const MESSAGE_TEXT_LIMIT = 3900;

let offset = 0;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required. Set it in Railway variables or .env locally.");
  process.exit(1);
}

if (ADMIN_IDS.length === 0) {
  console.warn("ADMIN_IDS is empty. Admin panel will be disabled.");
}

console.log(`Data directory: ${DATA_DIR}`);
console.log(`Lessons file: ${LESSONS_PATH}`);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function getLessons() {
  if (!fs.existsSync(LESSONS_PATH) && fs.existsSync(DEFAULT_LESSONS_PATH)) {
    writeJson(LESSONS_PATH, readJson(DEFAULT_LESSONS_PATH, []));
  }

  const lessons = readJson(LESSONS_PATH, []);
  return [...lessons].sort((a, b) => a.order - b.order);
}

function saveLessons(lessons) {
  const normalizedLessons = lessons
    .map((lesson, index) => ({ ...lesson, order: index + 1 }))
    .sort((a, b) => a.order - b.order);
  writeJson(LESSONS_PATH, normalizedLessons);
}

function getProgress() {
  return readJson(PROGRESS_PATH, {});
}

function saveProgress(progress) {
  writeJson(PROGRESS_PATH, progress);
}

function getAdminStates() {
  return readJson(ADMIN_STATE_PATH, {});
}

function getAdminState(userId) {
  return getAdminStates()[String(userId)] || null;
}

function setAdminState(userId, state) {
  const states = getAdminStates();
  if (state) {
    states[String(userId)] = state;
  } else {
    delete states[String(userId)];
  }
  writeJson(ADMIN_STATE_PATH, states);
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function telegram(method, payload) {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.description}`);
  }
  return data.result;
}

function studentNextButton() {
  return {
    inline_keyboard: [[{ text: "Следующий урок", callback_data: "next_lesson" }]],
  };
}

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Добавить урок", callback_data: "admin:add" }],
      [{ text: "Список уроков", callback_data: "admin:list" }],
      [{ text: "Отменить действие", callback_data: "admin:cancel" }],
    ],
  };
}

function adminReplyKeyboard() {
  return {
    keyboard: [
      [{ text: "Админ-панель" }],
      [{ text: "Добавить урок" }, { text: "Список уроков" }],
      [{ text: "Отменить действие" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function lessonListKeyboard(lessons) {
  const rows = lessons.map((lesson, index) => [
    { text: `${index + 1}. ${shortenText(lesson.title || "Без названия", 40)}`, callback_data: `admin:lesson:${index}` },
  ]);
  rows.push([{ text: "Назад", callback_data: "admin:menu" }]);
  return { inline_keyboard: rows };
}

function lessonEditKeyboard(index, lesson) {
  const rows = [
    [{ text: "Редактировать название", callback_data: `admin:edit:title:${index}` }],
    [{ text: "Редактировать текст", callback_data: `admin:edit:text:${index}` }],
    [{ text: lesson.media ? "Заменить медиа" : "Добавить медиа", callback_data: `admin:edit:media:${index}` }],
  ];

  if (lesson.media) {
    rows.push([{ text: "Удалить медиа", callback_data: `admin:remove_media:${index}` }]);
  }

  rows.push([{ text: "Удалить урок", callback_data: `admin:delete:${index}` }]);
  rows.push([{ text: "Назад к списку", callback_data: "admin:list" }]);
  return { inline_keyboard: rows };
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendLongMessage(chatId, text, finalExtra = {}) {
  const chunks = splitText(text, MESSAGE_TEXT_LIMIT);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await sendMessage(chatId, chunks[index], isLastChunk ? finalExtra : {});
  }
}

function splitText(text, maxLength) {
  const value = String(text);
  if (value.length <= maxLength) return [value];

  const chunks = [];
  let remaining = value;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function answerCallbackQuery(callbackQueryId, text) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function sendLesson(chatId, userId, lessonIndex) {
  const lessons = getLessons();

  if (lessons.length === 0) {
    await sendMessage(chatId, "Уроки пока не добавлены.");
    return;
  }

  if (lessonIndex >= lessons.length) {
    await sendMessage(chatId, "Все уроки пройдены.");
    return;
  }

  const lesson = lessons[lessonIndex];
  const progress = getProgress();
  progress[String(userId)] = lessonIndex;
  saveProgress(progress);

  const caption = lesson.text ? escapeHtml(lesson.text).trim() : "";
  const hasNext = lessonIndex + 1 < lessons.length;
  const replyMarkup = hasNext ? studentNextButton() : undefined;

  if (lesson.media?.file_id && lesson.media?.type) {
    if (caption.length > MEDIA_CAPTION_LIMIT) {
      await sendMessage(chatId, caption);
      await sendMedia(chatId, lesson.media.type, lesson.media.file_id, "", replyMarkup);
      return;
    }

    await sendMedia(chatId, lesson.media.type, lesson.media.file_id, caption, replyMarkup);
    return;
  }

  await sendMessage(chatId, caption || "Урок без текста.", {
    reply_markup: replyMarkup,
  });
}

async function sendMedia(chatId, type, fileId, caption, replyMarkup) {
  const methodByType = {
    audio: "sendAudio",
    document: "sendDocument",
    photo: "sendPhoto",
    video: "sendVideo",
    voice: "sendVoice",
  };
  const fieldByType = {
    audio: "audio",
    document: "document",
    photo: "photo",
    video: "video",
    voice: "voice",
  };

  const method = methodByType[type];
  const field = fieldByType[type];

  if (!method || !field) {
    throw new Error(`Unsupported media type: ${type}`);
  }

  return telegram(method, {
    chat_id: chatId,
    [field]: fileId,
    caption: caption || undefined,
    parse_mode: caption ? "HTML" : undefined,
    reply_markup: replyMarkup,
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractMedia(message) {
  if (message.video) return { type: "video", file_id: message.video.file_id };
  if (message.audio) return { type: "audio", file_id: message.audio.file_id };
  if (message.voice) return { type: "voice", file_id: message.voice.file_id };
  if (message.document) return { type: "document", file_id: message.document.file_id };
  if (message.photo) {
    const largestPhoto = message.photo[message.photo.length - 1];
    return { type: "photo", file_id: largestPhoto.file_id };
  }
  return null;
}

async function handleStart(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const progress = getProgress();
  const lessonIndex = progress[String(userId)] || 0;

  await sendLesson(chatId, userId, lessonIndex);
}

async function handleNext(chatId, userId) {
  const progress = getProgress();
  const currentIndex = progress[String(userId)] || 0;
  await sendLesson(chatId, userId, currentIndex + 1);
}

async function handleReset(message) {
  const progress = getProgress();
  delete progress[String(message.from.id)];
  saveProgress(progress);
  await sendMessage(message.chat.id, "Прогресс сброшен. Отправляю первый урок.");
  await sendLesson(message.chat.id, message.from.id, 0);
}

async function showAdminMenu(chatId) {
  await sendMessage(chatId, "Админские кнопки закреплены внизу чата.", {
    reply_markup: adminReplyKeyboard(),
  });
  await sendMessage(chatId, "Админ-панель", {
    reply_markup: adminMenuKeyboard(),
  });
}

async function showLessonsList(chatId) {
  const lessons = getLessons();
  if (lessons.length === 0) {
    await sendMessage(chatId, "Уроков пока нет.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const text = lessons
    .map((lesson, index) => `${index + 1}. ${escapeHtml(lesson.title || "Без названия")}`)
    .join("\n");

  await sendMessage(chatId, `<b>Уроки</b>\n\n${text}`, {
    reply_markup: lessonListKeyboard(lessons),
  });
}

async function showLessonEditor(chatId, index) {
  const lessons = getLessons();
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const mediaText = lesson.media
    ? `${lesson.media.type}, file_id сохранен`
    : "нет";
  const header = [
    `<b>Урок ${index + 1}</b>`,
    "",
    `<b>Название:</b> ${escapeHtml(lesson.title || "Без названия")}`,
    `<b>Медиа:</b> ${escapeHtml(mediaText)}`,
    "",
    `<b>Текст:</b>`,
  ].join("\n");
  const text = `${header}\n${escapeHtml(lesson.text || "Без текста")}`;

  await sendLongMessage(chatId, text, {
    reply_markup: lessonEditKeyboard(index, lesson),
  });
}

function shortenText(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

async function startLessonCreation(chatId, userId) {
  setAdminState(userId, {
    action: "add_lesson",
    step: "title",
    draft: {},
  });
  await sendMessage(chatId, "Напиши название урока. Для отмены отправь /cancel.");
}

async function startLessonEdit(chatId, userId, index, field) {
  const lessons = getLessons();
  if (!lessons[index]) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  setAdminState(userId, {
    action: "edit_lesson",
    index,
    field,
  });

  if (field === "title") {
    await sendMessage(chatId, "Отправь новое название урока. Для отмены отправь /cancel.");
    return;
  }

  if (field === "text") {
    await sendMessage(chatId, "Отправь новый текст урока. Для отмены отправь /cancel.");
    return;
  }

  if (field === "media") {
    await sendMessage(chatId, "Отправь новое видео, аудио, голосовое, фото или документ. Для отмены отправь /cancel.");
  }
}

async function handleAdminDraftMessage(message) {
  const state = getAdminState(message.from.id);
  if (!state) return false;

  const chatId = message.chat.id;
  const text = message.text?.trim();

  if (text === "/cancel") {
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Действие отменено.", {
      reply_markup: adminReplyKeyboard(),
    });
    return true;
  }

  if (state.action === "edit_lesson") {
    await handleLessonEditMessage(message, state);
    return true;
  }

  if (state.action !== "add_lesson") return false;

  if (state.step === "title") {
    if (!text) {
      await sendMessage(chatId, "Название должно быть текстом. Отправь название урока.");
      return true;
    }

    state.draft.title = text;
    state.step = "text";
    setAdminState(message.from.id, state);
    await sendMessage(chatId, "Теперь отправь текст или описание урока.");
    return true;
  }

  if (state.step === "text") {
    if (!text) {
      await sendMessage(chatId, "Описание должно быть текстом. Отправь текст урока.");
      return true;
    }

    state.draft.text = text;
    state.step = "media";
    setAdminState(message.from.id, state);
    await sendMessage(chatId, "Теперь отправь видео, аудио, голосовое, фото или документ. Если медиа нет, отправь /skip.");
    return true;
  }

  if (state.step === "media") {
    if (text === "/skip") {
      await publishAdminDraft(message.from.id, chatId, state.draft, null);
      return true;
    }

    const media = extractMedia(message);
    if (!media) {
      await sendMessage(chatId, "Отправь медиафайл или /skip.");
      return true;
    }

    await publishAdminDraft(message.from.id, chatId, state.draft, media);
    return true;
  }

  return false;
}

async function handleLessonEditMessage(message, state) {
  const chatId = message.chat.id;
  const lessons = getLessons();
  const lesson = lessons[state.index];

  if (!lesson) {
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  if (state.field === "title") {
    const title = message.text?.trim();
    if (!title) {
      await sendMessage(chatId, "Название должно быть текстом. Отправь новое название урока.");
      return;
    }

    lesson.title = title;
    saveLessons(lessons);
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Название обновлено.");
    await showLessonEditor(chatId, state.index);
    return;
  }

  if (state.field === "text") {
    const text = message.text?.trim();
    if (!text) {
      await sendMessage(chatId, "Текст должен быть текстом. Отправь новый текст урока.");
      return;
    }

    lesson.text = text;
    saveLessons(lessons);
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Текст обновлен.");
    await showLessonEditor(chatId, state.index);
    return;
  }

  if (state.field === "media") {
    const media = extractMedia(message);
    if (!media) {
      await sendMessage(chatId, "Отправь медиафайл: видео, аудио, голосовое, фото или документ.");
      return;
    }

    lesson.media = media;
    saveLessons(lessons);
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Медиа обновлено.");
    await showLessonEditor(chatId, state.index);
  }
}

async function publishAdminDraft(userId, chatId, draft, media) {
  const lessons = getLessons();
  lessons.push({
    order: lessons.length + 1,
    title: draft.title,
    text: draft.text,
    media,
  });
  saveLessons(lessons);
  setAdminState(userId, null);

  await sendMessage(chatId, "Урок добавлен.", {
    reply_markup: adminMenuKeyboard(),
  });
}

async function deleteLesson(chatId, index) {
  const lessons = getLessons();
  if (index < 0 || index >= lessons.length) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const [removedLesson] = lessons.splice(index, 1);
  saveLessons(lessons);
  normalizeProgressAfterLessonDelete(index);
  await sendMessage(chatId, `Удален урок: ${escapeHtml(removedLesson.title || "Без названия")}`, {
    reply_markup: adminMenuKeyboard(),
  });
}

async function removeLessonMedia(chatId, index) {
  const lessons = getLessons();
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  lesson.media = null;
  saveLessons(lessons);
  await sendMessage(chatId, "Медиа удалено.");
  await showLessonEditor(chatId, index);
}

function normalizeProgressAfterLessonDelete(deletedIndex) {
  const progress = getProgress();
  for (const [userId, lessonIndex] of Object.entries(progress)) {
    if (lessonIndex > deletedIndex) {
      progress[userId] = lessonIndex - 1;
    }
  }
  saveProgress(progress);
}

async function handleMediaId(message) {
  if (!isAdmin(message.from.id)) return false;

  const media = extractMedia(message);
  if (!media) return false;

  await sendMessage(
    message.chat.id,
    `file_id:\n<code>${escapeHtml(media.file_id)}</code>\n\nМожно добавить этот файл через /admin -> Добавить урок.`,
  );
  return true;
}

async function handleMessage(message) {
  if (isAdmin(message.from.id) && (await handleAdminDraftMessage(message))) return;
  if (!message.text && (await handleMediaId(message))) return;
  if (!message.text) return;

  const command = message.text.split(/\s+/)[0];

  if (command === "/start") {
    await handleStart(message);
    return;
  }

  if (command === "/next") {
    await handleNext(message.chat.id, message.from.id);
    return;
  }

  if (command === "/reset") {
    await handleReset(message);
    return;
  }

  if (command === "/myid") {
    await sendMessage(message.chat.id, `Твой Telegram ID: <code>${message.from.id}</code>`);
    return;
  }

  if (command === "/admin") {
    if (!isAdmin(message.from.id)) {
      await sendMessage(message.chat.id, "Эта команда доступна только админам.");
      return;
    }

    await showAdminMenu(message.chat.id);
    return;
  }

  if (isAdmin(message.from.id) && message.text === "Админ-панель") {
    await showAdminMenu(message.chat.id);
    return;
  }

  if (isAdmin(message.from.id) && message.text === "Добавить урок") {
    await startLessonCreation(message.chat.id, message.from.id);
    return;
  }

  if (isAdmin(message.from.id) && message.text === "Список уроков") {
    await showLessonsList(message.chat.id);
    return;
  }

  if (isAdmin(message.from.id) && message.text === "Отменить действие") {
    setAdminState(message.from.id, null);
    await sendMessage(message.chat.id, "Действие отменено.", {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  if (command === "/cancel" && isAdmin(message.from.id)) {
    setAdminState(message.from.id, null);
    await sendMessage(message.chat.id, "Действие отменено.", {
      reply_markup: adminReplyKeyboard(),
    });
    return;
  }

  if (command === "/help") {
    await sendMessage(
      message.chat.id,
      "Команды:\n/start - начать или продолжить\n/next - следующий урок\n/reset - начать заново\n/myid - узнать свой Telegram ID\n\nДля админов:\n/admin - управление уроками",
    );
  }
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  if (data === "next_lesson") {
    await answerCallbackQuery(callbackQuery.id);
    await handleNext(chatId, userId);
    return;
  }

  if (!data?.startsWith("admin:")) return;

  if (!isAdmin(userId)) {
    await answerCallbackQuery(callbackQuery.id, "Недоступно");
    return;
  }

  await answerCallbackQuery(callbackQuery.id);

  if (data === "admin:menu") {
    await showAdminMenu(chatId);
    return;
  }

  if (data === "admin:add") {
    await startLessonCreation(chatId, userId);
    return;
  }

  if (data === "admin:list") {
    await showLessonsList(chatId);
    return;
  }

  if (data === "admin:cancel") {
    setAdminState(userId, null);
    await sendMessage(chatId, "Действие отменено.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  if (data.startsWith("admin:lesson:")) {
    const index = Number(data.split(":")[2]);
    await showLessonEditor(chatId, index);
    return;
  }

  if (data.startsWith("admin:edit:")) {
    const [, , field, rawIndex] = data.split(":");
    await startLessonEdit(chatId, userId, Number(rawIndex), field);
    return;
  }

  if (data.startsWith("admin:remove_media:")) {
    const index = Number(data.split(":")[2]);
    await removeLessonMedia(chatId, index);
    return;
  }

  if (data.startsWith("admin:delete:")) {
    const index = Number(data.split(":")[2]);
    await deleteLesson(chatId, index);
  }
}

async function handleUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

poll();
