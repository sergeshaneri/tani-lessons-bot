const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
  const normalizedLessons = normalizeLessons(lessons);
  if (normalizedLessons.some((lesson, index) => lesson.id !== lessons[index]?.id)) {
    writeJson(LESSONS_PATH, normalizedLessons);
  }
  return normalizedLessons;
}

function saveLessons(lessons) {
  writeJson(LESSONS_PATH, normalizeLessons(lessons));
}

function normalizeLessons(lessons) {
  return lessons
    .map((lesson, index) => ({
      ...lesson,
      id: lesson.id || createLessonId(),
      order: index + 1,
      media: normalizeMedia(lesson.media),
      blocks: normalizeBlocks(lesson.blocks, lesson.extras),
      extras: undefined,
    }))
    .sort((a, b) => a.order - b.order);
}

function createLessonId() {
  return crypto.randomBytes(6).toString("hex");
}

function findLessonIndex(lessons, lessonRef) {
  return lessons.findIndex((lesson) => lesson.id === lessonRef);
}

function normalizeMedia(media) {
  if (!media) return [];
  if (Array.isArray(media)) return media.filter((item) => item?.file_id && item?.type);
  if (media.file_id && media.type) return [media];
  return [];
}

function normalizeExtras(extras) {
  if (!extras) return [];
  if (Array.isArray(extras)) return extras.map((item) => String(item).trim()).filter(Boolean);
  return [String(extras).trim()].filter(Boolean);
}

function normalizeBlocks(blocks, legacyExtras = []) {
  const normalizedBlocks = Array.isArray(blocks)
    ? blocks
        .map((block) => {
          if (block?.type === "text" && block.text) {
            return { type: "text", text: String(block.text).trim() };
          }
          if (block?.type === "media") {
            const media = normalizeMedia(block.media)[0];
            return media ? { type: "media", media } : null;
          }
          return null;
        })
        .filter(Boolean)
    : [];

  const legacyBlocks = normalizeExtras(legacyExtras).map((text) => ({ type: "text", text }));
  return [...normalizedBlocks, ...legacyBlocks];
}

function blockFromMessage(message) {
  const media = extractMedia(message);
  if (media) return { type: "media", media };

  const text = message.text?.trim();
  if (text) return { type: "text", text };

  return null;
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

function adminDoneSkipKeyboard({ allowSkip = true } = {}) {
  const controlRow = allowSkip
    ? [{ text: "Готово" }, { text: "Пропустить" }]
    : [{ text: "Готово" }];

  return {
    keyboard: [
      controlRow,
      [{ text: "Отменить действие" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function normalizeAdminControlText(text) {
  if (text === "Готово") return "/done";
  if (text === "Пропустить") return "/skip";
  if (text === "Отменить действие") return "/cancel";
  return text;
}

function lessonListKeyboard(lessons) {
  const rows = lessons.map((lesson, index) => [
    { text: `${index + 1}. ${shortenText(lesson.title || "Без названия", 40)}`, callback_data: `admin:lesson:${lesson.id}` },
  ]);
  rows.push([{ text: "Назад", callback_data: "admin:menu" }]);
  return { inline_keyboard: rows };
}

function lessonEditKeyboard(index, lesson) {
  const lessonRef = lesson.id || String(index);
  const mediaItems = normalizeMedia(lesson.media);
  const blocks = normalizeBlocks(lesson.blocks, lesson.extras);
  const rows = [
    [{ text: "Редактировать название", callback_data: `admin:edit:title:${lessonRef}` }],
    [{ text: "Редактировать текст", callback_data: `admin:edit:text:${lessonRef}` }],
    [{ text: "Добавить допблок", callback_data: `admin:edit:add_block:${lessonRef}` }],
    [{ text: "Заменить все допблоки", callback_data: `admin:edit:replace_blocks:${lessonRef}` }],
    [{ text: "Добавить медиа", callback_data: `admin:edit:add_media:${lessonRef}` }],
    [{ text: "Заменить все медиа", callback_data: `admin:edit:replace_media:${lessonRef}` }],
  ];

  if (blocks.length > 0) {
    rows.push([{ text: "Удалить все допблоки", callback_data: `admin:remove_blocks:${lessonRef}` }]);
  }

  if (mediaItems.length > 0) {
    rows.push([{ text: "Удалить все медиа", callback_data: `admin:remove_media:${lessonRef}` }]);
  }

  rows.push([{ text: "Добавить урок перед этим", callback_data: `admin:add_before:${lessonRef}` }]);
  rows.push([{ text: "Удалить урок", callback_data: `admin:confirm_delete:${lessonRef}` }]);
  rows.push([{ text: "Назад к списку", callback_data: "admin:list" }]);
  return { inline_keyboard: rows };
}

function deleteConfirmKeyboard(lessonRef) {
  return {
    inline_keyboard: [
      [{ text: "Да, удалить урок", callback_data: `admin:delete:${lessonRef}` }],
      [{ text: "Нет, оставить", callback_data: `admin:lesson:${lessonRef}` }],
    ],
  };
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

async function sendLongPlainMessage(chatId, text, finalExtra = {}) {
  const chunks = splitText(text || "Урок без текста.", MESSAGE_TEXT_LIMIT);

  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await sendMessage(chatId, escapeHtml(chunks[index]), isLastChunk ? finalExtra : {});
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
  const mediaItems = normalizeMedia(lesson.media);
  const blocks = normalizeBlocks(lesson.blocks, lesson.extras);
  const progress = getProgress();
  progress[String(userId)] = lessonIndex;
  saveProgress(progress);

  const lessonText = lesson.text ? String(lesson.text).trim() : "";
  const hasNext = lessonIndex + 1 < lessons.length;
  const replyMarkup = hasNext ? studentNextButton() : undefined;

  if (mediaItems.length > 0) {
    const escapedLessonText = escapeHtml(lessonText);
    if (
      blocks.length === 0 &&
      mediaItems.length === 1 &&
      escapedLessonText.length > 0 &&
      escapedLessonText.length <= MEDIA_CAPTION_LIMIT
    ) {
      await sendMedia(chatId, mediaItems[0].type, mediaItems[0].file_id, escapedLessonText, replyMarkup);
      return;
    }

    if (lessonText) {
      await sendLongPlainMessage(chatId, lessonText);
    }

    for (let index = 0; index < mediaItems.length; index += 1) {
      const isLastMedia = index === mediaItems.length - 1;
      const mediaReplyMarkup = isLastMedia && blocks.length === 0 ? replyMarkup : undefined;
      await sendMedia(chatId, mediaItems[index].type, mediaItems[index].file_id, "", mediaReplyMarkup);
    }
    if (blocks.length > 0) {
      await sendBlocks(chatId, blocks, replyMarkup);
    }
    return;
  }

  if (blocks.length > 0) {
    await sendLongPlainMessage(chatId, lessonText || "Урок без текста.");
    await sendBlocks(chatId, blocks, replyMarkup);
    return;
  }

  await sendLongPlainMessage(chatId, lessonText || "Урок без текста.", {
    reply_markup: replyMarkup,
  });
}

async function sendBlocks(chatId, blocks, replyMarkup) {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const isLastBlock = index === blocks.length - 1;
    const blockReplyMarkup = isLastBlock ? replyMarkup : undefined;

    if (block.type === "text") {
      await sendLongPlainMessage(chatId, block.text, { reply_markup: blockReplyMarkup });
      continue;
    }

    if (block.type === "media") {
      await sendMedia(chatId, block.media.type, block.media.file_id, "", blockReplyMarkup);
    }
  }
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

async function showLessonEditor(chatId, lessonRef) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const mediaItems = normalizeMedia(lesson.media);
  const blocks = normalizeBlocks(lesson.blocks, lesson.extras);
  const mediaText = mediaItems.length > 0
    ? `${mediaItems.length} файл(ов): ${mediaItems.map((item) => item.type).join(", ")}`
    : "нет";
  const blocksText = blocks.length > 0
    ? `${blocks.length} блок(ов): ${blocks.map(formatBlockType).join(", ")}`
    : "нет";
  const header = [
    `<b>Урок ${index + 1}</b>`,
    "",
    `<b>Название:</b> ${escapeHtml(lesson.title || "Без названия")}`,
    `<b>Медиа:</b> ${escapeHtml(mediaText)}`,
    `<b>Допблоки:</b> ${escapeHtml(blocksText)}`,
  ].join("\n");

  await sendMessage(chatId, header);
  if (blocks.length === 0) {
    await sendLongPlainMessage(chatId, lesson.text || "Без текста", {
      reply_markup: lessonEditKeyboard(index, lesson),
    });
    return;
  }

  await sendLongPlainMessage(chatId, lesson.text || "Без текста");
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const isLastBlock = blockIndex === blocks.length - 1;
    await sendMessage(chatId, `<b>Допблок ${blockIndex + 1}: ${escapeHtml(formatBlockType(block))}</b>`);

    if (block.type === "text") {
      await sendLongPlainMessage(chatId, block.text, isLastBlock ? {
        reply_markup: lessonEditKeyboard(index, lesson),
      } : {});
      continue;
    }

    if (block.type === "media") {
      await sendMedia(chatId, block.media.type, block.media.file_id, "", isLastBlock ? lessonEditKeyboard(index, lesson) : undefined);
    }
  }
}

function formatBlockType(block) {
  if (block.type === "text") return "текст";
  if (block.type === "media") return block.media?.type || "медиа";
  return "неизвестно";
}

function shortenText(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

async function startLessonCreation(chatId, userId, insertBeforeRef = null) {
  const lessons = getLessons();
  const insertBeforeIndex = insertBeforeRef ? findLessonIndex(lessons, insertBeforeRef) : -1;
  const insertBeforeLesson = insertBeforeIndex === -1 ? null : lessons[insertBeforeIndex];

  setAdminState(userId, {
    action: "add_lesson",
    step: "title",
    draft: {},
    insertBeforeId: insertBeforeLesson?.id || null,
  });
  const placeText = insertBeforeLesson
    ? ` Новый урок будет добавлен перед: ${insertBeforeIndex + 1}. ${insertBeforeLesson.title || "Без названия"}.`
    : "";
  await sendMessage(chatId, `Напиши название урока.${placeText} Для отмены отправь /cancel.`);
}

async function startLessonEdit(chatId, userId, lessonRef, field) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
  if (!lessons[index]) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  const editState = {
    action: "edit_lesson",
    lessonId: lessons[index].id,
    field,
  };
  setAdminState(userId, editState);

  if (field === "title") {
    await sendMessage(chatId, "Отправь новое название урока. Для отмены отправь /cancel.");
    return;
  }

  if (field === "text") {
    await sendMessage(chatId, "Отправь новый текст урока. Для отмены отправь /cancel.");
    return;
  }

  if (field === "add_block") {
    await sendMessage(chatId, "Отправь текст или медиафайл, который нужно добавить после основного урока. Для отмены отправь /cancel.");
    return;
  }

  if (field === "replace_blocks") {
    setAdminState(userId, { ...editState, blocks: [] });
    await sendMessage(chatId, "Отправь новые допблоки одно за другим: текст, видео, аудио, фото или документ. Они заменят все текущие допблоки. Когда закончишь, нажми Готово.", {
      reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
    });
    return;
  }

  if (field === "add_media") {
    await sendMessage(chatId, "Отправь видео, аудио, голосовое, фото или документ, которое нужно добавить к уроку. Для отмены отправь /cancel.");
    return;
  }

  if (field === "replace_media") {
    setAdminState(userId, { ...editState, media: [] });
    await sendMessage(chatId, "Отправь один или несколько новых медиафайлов. Они заменят все текущие медиа. Когда закончишь, нажми Готово.", {
      reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
    });
  }
}

async function handleAdminDraftMessage(message) {
  const state = getAdminState(message.from.id);
  if (!state) return false;

  const chatId = message.chat.id;
  const text = normalizeAdminControlText(message.text?.trim());

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
    state.draft.media = [];
    setAdminState(message.from.id, state);
    await sendMessage(chatId, "Теперь отправь одно или несколько видео, аудио, голосовых, фото или документов. Когда закончишь, нажми Готово. Если медиа нет, нажми Пропустить.", {
      reply_markup: adminDoneSkipKeyboard(),
    });
    return true;
  }

  if (state.step === "media") {
    if (text === "/skip") {
      await startExtrasCreationStep(message.from.id, chatId, state, []);
      return true;
    }

    if (text === "/done") {
      await startExtrasCreationStep(message.from.id, chatId, state, state.draft.media || []);
      return true;
    }

    const media = extractMedia(message);
    if (!media) {
      await sendMessage(chatId, "Отправь медиафайл, нажми Готово или Пропустить.", {
        reply_markup: adminDoneSkipKeyboard(),
      });
      return true;
    }

    state.draft.media = [...(state.draft.media || []), media];
    setAdminState(message.from.id, state);
    await sendMessage(chatId, `Медиа добавлено: ${state.draft.media.length}. Можешь отправить еще файл или нажать Готово.`, {
      reply_markup: adminDoneSkipKeyboard(),
    });
    return true;
  }

  if (state.step === "blocks") {
    if (text === "/skip" || text === "/done") {
      await publishAdminDraft(message.from.id, chatId, state.draft);
      return true;
    }

    const block = blockFromMessage(message);
    if (!block) {
      await sendMessage(chatId, "Отправь текст или медиафайл, нажми Готово или Пропустить.", {
        reply_markup: adminDoneSkipKeyboard(),
      });
      return true;
    }

    state.draft.blocks = [...(state.draft.blocks || []), block];
    setAdminState(message.from.id, state);
    await sendMessage(chatId, `Допблок добавлен: ${state.draft.blocks.length}. Можешь отправить еще текст/медиа или нажать Готово.`, {
      reply_markup: adminDoneSkipKeyboard(),
    });
    return true;
  }

  return false;
}

async function handleLessonEditMessage(message, state) {
  const chatId = message.chat.id;
  const controlText = normalizeAdminControlText(message.text?.trim());
  const lessons = getLessons();
  const lessonRef = state.lessonId || state.index;
  const lessonIndex = findLessonIndex(lessons, lessonRef);
  const lesson = lessons[lessonIndex];

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
    await showLessonEditor(chatId, lessonRef);
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
    await showLessonEditor(chatId, lessonRef);
    return;
  }

  if (state.field === "add_block") {
    const block = blockFromMessage(message);
    if (!block) {
      await sendMessage(chatId, "Отправь текст или медиафайл для допблока.");
      return;
    }

    lesson.blocks = [...normalizeBlocks(lesson.blocks, lesson.extras), block];
    lesson.extras = undefined;
    saveLessons(lessons);
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Допблок добавлен.");
    await showLessonEditor(chatId, lessonRef);
    return;
  }

  if (state.field === "replace_blocks") {
    const text = controlText;
    if (text === "/done") {
      lesson.blocks = normalizeBlocks(state.blocks);
      lesson.extras = undefined;
      saveLessons(lessons);
      setAdminState(message.from.id, null);
      await sendMessage(chatId, "Допблоки заменены.", {
        reply_markup: adminReplyKeyboard(),
      });
      await showLessonEditor(chatId, lessonRef);
      return;
    }

    const block = blockFromMessage(message);
    if (!block) {
      await sendMessage(chatId, "Отправь текст, медиафайл или нажми Готово.", {
        reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
      });
      return;
    }

    state.blocks = [...(state.blocks || []), block];
    setAdminState(message.from.id, state);
    await sendMessage(chatId, `Допблок добавлен в новый набор: ${state.blocks.length}. Можешь отправить еще текст/медиа или нажать Готово.`, {
      reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
    });
    return;
  }

  if (state.field === "add_media") {
    const media = extractMedia(message);
    if (!media) {
      await sendMessage(chatId, "Отправь медиафайл: видео, аудио, голосовое, фото или документ.");
      return;
    }

    lesson.media = [...normalizeMedia(lesson.media), media];
    saveLessons(lessons);
    setAdminState(message.from.id, null);
    await sendMessage(chatId, "Медиа добавлено.");
    await showLessonEditor(chatId, lessonRef);
    return;
  }

  if (state.field === "replace_media") {
    if (controlText === "/done") {
      lesson.media = state.media || [];
      saveLessons(lessons);
      setAdminState(message.from.id, null);
      await sendMessage(chatId, "Медиа заменено.", {
        reply_markup: adminReplyKeyboard(),
      });
      await showLessonEditor(chatId, lessonRef);
      return;
    }

    const media = extractMedia(message);
    if (!media) {
      await sendMessage(chatId, "Отправь медиафайл или нажми Готово.", {
        reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
      });
      return;
    }

    state.media = [...(state.media || []), media];
    setAdminState(message.from.id, state);
    await sendMessage(chatId, `Медиа добавлено в новый набор: ${state.media.length}. Можешь отправить еще файл или нажать Готово.`, {
      reply_markup: adminDoneSkipKeyboard({ allowSkip: false }),
    });
  }
}

async function startExtrasCreationStep(userId, chatId, state, media) {
  state.draft.media = normalizeMedia(media);
  state.draft.blocks = [];
  state.step = "blocks";
  setAdminState(userId, state);
  await sendMessage(chatId, "Теперь отправь допблоки после основного урока: текст, видео, аудио, фото или документ в нужном порядке. Когда закончишь, нажми Готово. Если допблоков нет, нажми Пропустить.", {
    reply_markup: adminDoneSkipKeyboard(),
  });
}

async function publishAdminDraft(userId, chatId, draft) {
  const lessons = getLessons();
  const newLesson = {
    order: lessons.length + 1,
    title: draft.title,
    text: draft.text,
    media: normalizeMedia(draft.media),
    blocks: normalizeBlocks(draft.blocks),
  };
  const insertBeforeId = getAdminState(userId)?.insertBeforeId;
  const insertBeforeIndex = insertBeforeId ? findLessonIndex(lessons, insertBeforeId) : -1;

  if (insertBeforeIndex === -1) {
    lessons.push(newLesson);
  } else {
    lessons.splice(insertBeforeIndex, 0, newLesson);
    normalizeProgressAfterLessonInsert(insertBeforeIndex);
  }

  saveLessons(lessons);
  setAdminState(userId, null);

  await sendMessage(chatId, "Урок добавлен.", {
    reply_markup: adminReplyKeyboard(),
  });
  await showAdminMenu(chatId);
}

async function deleteLesson(chatId, lessonRef) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
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

async function confirmDeleteLesson(chatId, lessonRef) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  await sendMessage(
    chatId,
    `Точно удалить урок ${index + 1}: ${escapeHtml(lesson.title || "Без названия")}?`,
    { reply_markup: deleteConfirmKeyboard(lesson.id || lessonRef) },
  );
}

async function removeLessonMedia(chatId, lessonRef) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  lesson.media = [];
  saveLessons(lessons);
  await sendMessage(chatId, "Медиа удалено.");
  await showLessonEditor(chatId, lessonRef);
}

async function removeLessonBlocks(chatId, lessonRef) {
  const lessons = getLessons();
  const index = findLessonIndex(lessons, lessonRef);
  const lesson = lessons[index];

  if (!lesson) {
    await sendMessage(chatId, "Урок не найден.", {
      reply_markup: adminMenuKeyboard(),
    });
    return;
  }

  lesson.blocks = [];
  lesson.extras = undefined;
  saveLessons(lessons);
  await sendMessage(chatId, "Допблоки удалены.");
  await showLessonEditor(chatId, lessonRef);
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

function normalizeProgressAfterLessonInsert(insertedIndex) {
  const progress = getProgress();
  for (const [userId, lessonIndex] of Object.entries(progress)) {
    if (lessonIndex >= insertedIndex) {
      progress[userId] = lessonIndex + 1;
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

  if (data.startsWith("admin:add_before:")) {
    const lessonRef = data.split(":")[2];
    await startLessonCreation(chatId, userId, lessonRef);
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
    const lessonRef = data.split(":")[2];
    await showLessonEditor(chatId, lessonRef);
    return;
  }

  if (data.startsWith("admin:edit:")) {
    const [, , field, lessonRef] = data.split(":");
    await startLessonEdit(chatId, userId, lessonRef, field);
    return;
  }

  if (data.startsWith("admin:remove_media:")) {
    const lessonRef = data.split(":")[2];
    await removeLessonMedia(chatId, lessonRef);
    return;
  }

  if (data.startsWith("admin:remove_blocks:")) {
    const lessonRef = data.split(":")[2];
    await removeLessonBlocks(chatId, lessonRef);
    return;
  }

  if (data.startsWith("admin:confirm_delete:")) {
    const lessonRef = data.split(":")[2];
    await confirmDeleteLesson(chatId, lessonRef);
    return;
  }

  if (data.startsWith("admin:delete:")) {
    const lessonRef = data.split(":")[2];
    await deleteLesson(chatId, lessonRef);
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
