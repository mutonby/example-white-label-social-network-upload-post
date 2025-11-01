## Social Video Editor (MVP)

### Stack Overview
- **API** – Fastify (Node 20). Proxies Upload-Post, exposes FFmpeg helpers, auth, and social publishing endpoints.
- **Web** – Vite + React single-page app with the editor and publishing flow.
- **Postgres** – Users and presets storage (planned).
- **Redis** – Reserved for queues/cache (future work).

### Requirements
- Docker & Docker Compose.
- Upload-Post API key (copy `env.sample` → `.env` or use `--env-file env.sample`).

### Environment Variables
Set them in `.env` or export them before running compose:
- `UPLOAD_POST_API_KEY` – Upload-Post API key.
- `UPLOAD_POST_API_BASE` – defaults to `https://api.upload-post.com`.
- `NEXT_PUBLIC_API_BASE_URL` – frontend → backend URL (`http://localhost:4000`).

### Run the stack
```bash
# from repo root
# optional: docker compose --env-file env.sample up --build

docker compose up --build
```
- Web UI: http://localhost:3000
- API health: http://localhost:4000/health

### Key API Endpoints
- `GET /api/analytics/:profileUsername?platforms=instagram,youtube,threads`
- `POST /api/ffmpeg/jobs` `{ fileUrl, fullCommand, outputExtension }`
- `POST /api/ffmpeg/jobs/silence-cutter` `{ fileUrl, silenceDb, minSilenceSec }`
- `POST /api/ffmpeg/jobs/auto-916` `{ fileUrl, blur, format }`
- `POST /api/ffmpeg/jobs/text-overlay` `{ fileUrl, text, position, fontSize, color, bgColor, align }`
- `POST /api/auth/register` `{ username, password }`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/social/profile` – Upload-Post profile info for the logged user.
- `POST /api/social/connect-url` – short-lived JWT URL to connect social accounts.
- `POST /api/social/upload-video` – publish videos to connected networks (multipart file or JSON `fileUrl`).
- `GET /api/social/facebook/pages`, `/linkedin/pages`, `/pinterest/boards` – helpers to wire destinations.

All FFmpeg endpoints require an accessible `fileUrl`. The API downloads the asset, relays it to Upload-Post, and returns the processed output.

### Upload-Post Notes
- FFmpeg command templates must include `{input}` and `{output}`.
- Job statuses: `PENDING`, `PROCESSING`, `FINISHED`, `ERROR`.
- Download results only when status is `FINISHED`.
- Reference docs: https://docs.upload-post.com/llm.txt

### Authentication Flow Basics
- Username/password signup & login with bcrypt hashes and JWT (`JWT_SECRET`).
- Each signup creates a linked Upload-Post profile (`/api/uploadposts/users`).
- From the frontend users can:
  - Open the Upload-Post connection portal (`/api/social/connect-url`).
  - Inspect connected accounts (`/api/social/profile`).
  - Publish videos directly (`/api/social/upload-video`).

### Roadmap Ideas
- End-to-end OAuth/white-label user-profile experience.
- Persist presets and publish history in Postgres.
- Queue/worker & polling strategy for long Upload-Post tasks.
- Client-side 10–15s preview clips.
