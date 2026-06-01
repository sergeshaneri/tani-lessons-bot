# Tani Lessons Bot

Telegram bot for sending online school lessons with a "Следующий урок" button.

## Local Run

1. Create a bot through BotFather and copy the token.
2. Copy `.env.example` to `.env`.
3. Set `BOT_TOKEN`.
4. Set `ADMIN_IDS` to your Telegram user ID. Multiple IDs can be comma-separated.
5. Send `/myid` to the bot to see your Telegram ID.
6. Run:

```bash
npm start
```

Node.js 18 or newer is required.

## Admin Panel

Admins manage lessons directly in Telegram:

```text
/admin
```

After an admin sends `/admin`, Telegram shows persistent admin buttons in that admin's chat.
Non-admin users do not get these buttons and cannot access admin callbacks.

The admin panel supports:

- adding lessons step by step;
- editing lesson labels, text, main media, and extra blocks;
- attaching one or multiple main media files;
- adding extra blocks after the main lesson;
- mixing text and media inside extra blocks;
- listing and deleting lessons.

## Lesson Structure

`title` is an internal admin label. Students receive only `text`, main `media`, and `blocks`.

Text-only lesson:

```json
{
  "order": 1,
  "title": "Lesson 1",
  "text": "Main lesson text",
  "media": [],
  "blocks": []
}
```

Lesson with main videos and mixed extra blocks:

```json
{
  "order": 2,
  "title": "Lesson 2",
  "text": "Main lesson script",
  "media": [
    {
      "type": "video",
      "file_id": "main_video_file_id"
    }
  ],
  "blocks": [
    {
      "type": "text",
      "text": "Additional assignment"
    },
    {
      "type": "media",
      "media": {
        "type": "video",
        "file_id": "extra_video_file_id"
      }
    },
    {
      "type": "text",
      "text": "Final note after the extra video"
    }
  ]
}
```

Supported media types: `audio`, `document`, `photo`, `video`, `voice`.

During lesson creation:

1. Send the admin label.
2. Send the main lesson text.
3. Send main lesson media files one by one, then `/done`, or `/skip`.
4. Send extra blocks in the exact order students should receive them: text, media, text, media, etc.
5. Send `/done`, or `/skip` if there are no extra blocks.

In Telegram, admins can use the `Готово` and `Пропустить` buttons instead of typing `/done` and `/skip`.

## Railway

Add Railway variables:

```text
BOT_TOKEN=...
ADMIN_IDS=...
```

Current lessons, admin drafts, and student progress are saved in the data directory.
On Railway, the bot automatically uses `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached.
You can also override the storage folder with `DATA_DIR`.

Recommended Railway volume mount path:

```text
/app/data
```
