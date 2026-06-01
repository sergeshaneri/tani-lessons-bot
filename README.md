# Tani Lessons Bot

Telegram bot for sending lesson content with a "Следующий урок" button.

## Local run

1. Create a bot through BotFather and copy the token.
2. Copy `.env.example` to `.env`.
3. Set `BOT_TOKEN`.
4. Set `ADMIN_IDS` to your Telegram user ID. Multiple IDs can be comma-separated. Send `/myid` to the bot to see your ID.
5. Run:

```bash
npm start
```

Node.js 18 or newer is required.

## Lessons

Bundled starter lessons are stored in `lessons.json`.
When the bot runs, editable lessons are stored in `data/lessons.json`.

Admins can manage lessons directly in Telegram:

```text
/admin
```

After an admin sends `/admin`, Telegram shows persistent admin buttons in that admin's chat.
Non-admin users do not get these buttons and cannot access admin callbacks.
When an admin opens a lesson, the full lesson text is shown. Long lessons are split into multiple Telegram messages.

The admin panel supports:

- adding a lesson step by step;
- attaching one or multiple video, audio, voice, photo, or document files;
- listing lessons;
- editing lesson title, text, and media;
- deleting lessons.

If `ADMIN_IDS` is empty, the admin panel is disabled.

Text-only lesson:

```json
{
  "order": 1,
  "title": "Урок 1",
  "text": "Текст урока",
  "media": null
}
```

`title` is an internal admin label. Students receive only the `text` content and attached media.

Lesson with video:

```json
{
  "order": 2,
  "title": "Урок 2",
  "text": "Описание видео",
  "media": [
    {
      "type": "video",
      "file_id": "telegram_file_id_here"
    },
    {
      "type": "video",
      "file_id": "second_telegram_file_id_here"
    }
  ]
}
```

Supported media types: `audio`, `document`, `photo`, `video`, `voice`.
When adding a lesson in `/admin`, send multiple media files one by one and then send `/done`.

## Getting file_id

Send an audio, video, voice, photo, or document to the bot from an admin account.
The bot will reply with the `file_id` and a ready JSON fragment for `lessons.json`.

For large files, upload them to Telegram manually by sending them to the bot. Then reuse the returned `file_id` in `lessons.json`.

You usually do not need to edit JSON manually now: use `/admin`, choose "Добавить урок", and send the file during the media step.

## Railway

1. Push this project to GitHub.
2. Create a Railway project from the GitHub repository.
3. Add Railway variables:

```text
BOT_TOKEN=...
ADMIN_IDS=...
```

4. Railway will run `npm start`.

Current lessons, admin drafts, and student progress are saved in `data/`.
On Railway, the bot automatically uses `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached.
You can also override the storage folder with `DATA_DIR`.

Recommended Railway volume mount path:

```text
/app/data
```

If the volume is mounted somewhere else, keep it as-is; the bot will use Railway's `RAILWAY_VOLUME_MOUNT_PATH`.
On Railway without a persistent volume these files may reset on redeploy.
