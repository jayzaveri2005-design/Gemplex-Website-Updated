# Gemplex Website

Structured website for the Gemplex OTT concept with a React/Vue admin panel, optional Node/MySQL CMS API, and a Laravel/MySQL backend upgrade.

## Folder Structure

- `index.html` - Public user-facing website
- `admin.html` - Separate admin/editor panel
- `css/styles.css` - Shared website and admin styling
- `js/content-store.js` - Shared browser CMS store with default website content and localStorage persistence
- `js/script.js` - Public website renderer, search, theme, and saved content loading
- `js/admin-app.js` - React CMS editor with create/update/delete upload management and Vue live preview
- `server.js` - Express API and static server backed by MySQL
- `db/schema.sql` - MySQL database and table schema
- `laravel-backend/` - Laravel backend with MySQL, RBAC, token auth, CRUD APIs, media uploads, and file manager routes
- `LARAVEL_BACKEND.md` - Laravel setup and migration notes
- `.env.example` - Backend configuration template
- `assets/` - SVG posters, hero artwork, and visual assets

Open `index.html` for the public website and `admin.html` for the editor/admin panel. Direct file usage saves in the browser; when served through `server.js`, the same admin saves into MySQL.

The Uploads tab works like a lightweight YouTube-style content manager: create new uploads, edit metadata, upload thumbnail/video files, publish or draft items, and delete uploads. Uploaded files are stored as data URLs inside the CMS JSON, so keep videos small unless you move media files to object storage.

## MySQL Backend

1. Create a `.env` file from `.env.example` and set your MySQL username/password.
2. Install dependencies with `npm install`.
3. Start the server with `npm start`.
4. Open `http://localhost:3000/admin.html`.

The backend creates the configured database and tables automatically. You can also run `db/schema.sql` manually in MySQL.

API routes:

- `GET /api/health` - Check database connectivity
- `GET /api/content` - Load CMS content from MySQL
- `PUT /api/content` - Save CMS content to MySQL
- `POST /api/content/reset` - Reset CMS content in MySQL
- `GET /api/uploads` - Read normalized upload rows

## Laravel Backend Upgrade

The Laravel backend lives in `laravel-backend/`. It adds RBAC, Sanctum token auth, MySQL migrations, CRUD routes, upload/file-manager APIs, and seeded admin/editor/viewer roles.

Install PHP 8.3+ and Composer, then follow `LARAVEL_BACKEND.md`.
