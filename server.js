const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const rootDir = __dirname;
const contentId = "website";
const dataDir = path.join(rootDir, "data");
const uploadsDir = path.join(rootDir, "uploads");
const laravelPublicStorageDir = path.join(rootDir, "laravel-backend", "storage", "app", "public");
const fileManagerRoots = {
  uploads: uploadsDir,
  storage: laravelPublicStorageDir,
  assets: path.join(rootDir, "assets"),
  data: dataDir,
  css: path.join(rootDir, "css"),
  js: path.join(rootDir, "js")
};
const fallbackContentPath = path.join(dataDir, "cms-content.json");
const authUsersPath = path.join(dataDir, "auth-users.json");
const adminSessionsPath = path.join(dataDir, "admin-sessions.json");
const envPath = path.join(rootDir, ".env");
const staticCache = new Map();

function loadEnv() {
  if (!fsSync.existsSync(envPath)) {
    return;
  }

  const lines = fsSync.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      return;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

loadEnv();

const port = Number(process.env.PORT || 3000);
const dbName = process.env.DB_NAME || "gemplex_cms";

let pool = null;
let mysqlStatus = "not-installed";
let fallbackContentCache = null;
const pendingOtps = new Map();
const activeSessions = new Map();
const activeAdminSessions = new Map();
const pendingSignups = new Map();
const rateLimitBuckets = new Map();
const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || "";
const protectedStaticNames = new Set([
  ".env",
  ".env.example",
  "package.json",
  "package-lock.json",
  "server.js",
  "server.err.log",
  "server.out.log",
  "README.md",
  "LARAVEL_BACKEND.md"
]);
const publicStaticRoots = new Map([
  ["assets", path.join(rootDir, "assets")],
  ["css", path.join(rootDir, "css")],
  ["js", path.join(rootDir, "js")],
  ["uploads", uploadsDir],
  ["storage", laravelPublicStorageDir]
]);
const writableFileRoots = new Set(["uploads", "storage", "assets"]);
const allowedUploadExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
  ".vtt",
  ".srt",
  ".pdf",
  ".txt"
]);

loadPersistedAdminSessions();

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getSecurityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' https:;"
  };
}

function getOriginHeader(request) {
  const host = request.headers.host || `localhost:${port}`;
  const origin = request.headers.origin || `http://${host}`;
  try {
    const originUrl = new URL(origin);
    const hostName = host.split(":")[0];
    if (originUrl.hostname === hostName || ["localhost", "127.0.0.1", "::1"].includes(originUrl.hostname)) {
      return origin;
    }
  } catch (error) {
    // Fall through to same-origin localhost default.
  }
  return `http://${host}`;
}

function checkRateLimit(request, key, limit, windowMs) {
  const ip = request.socket.remoteAddress || "local";
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (bucket.resetAt < now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(bucketKey, bucket);
  return bucket.count <= limit;
}

function loadPersistedAdminSessions() {
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    const payload = JSON.parse(fsSync.readFileSync(adminSessionsPath, "utf8"));
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    sessions.forEach((session) => {
      if (session?.token && new Date(session.expiresAt).getTime() > Date.now()) {
        activeAdminSessions.set(session.token, session);
      }
    });
  } catch (error) {
    // No persisted admin session yet.
  }
}

function persistAdminSessions() {
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    const sessions = Array.from(activeAdminSessions.values())
      .filter((session) => new Date(session.expiresAt).getTime() > Date.now());
    fsSync.writeFileSync(adminSessionsPath, JSON.stringify({ sessions }, null, 2));
  } catch (error) {
    console.warn("Could not persist admin sessions", error.message);
  }
}

function getBearerToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function createSession(mobile) {
  const token = createToken();
  const now = Date.now();
  const session = {
    token,
    mobile,
    plan: "Gemplex Premium",
    deviceLimit: 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000 * 60 * 60 * 24 * 30).toISOString()
  };

  for (const [existingToken, existingSession] of activeSessions.entries()) {
    if (existingSession.mobile === mobile) {
      activeSessions.delete(existingToken);
    }
  }

  activeSessions.set(token, session);
  return session;
}

function createAdminSession(email) {
  const token = createToken();
  const now = Date.now();
  const session = {
    token,
    email,
    role: "admin",
    name: "Gemplex Admin",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000 * 60 * 60 * 8).toISOString()
  };

  for (const [existingToken, existingSession] of activeAdminSessions.entries()) {
    if (existingSession.email === email) {
      activeAdminSessions.delete(existingToken);
    }
  }

  activeAdminSessions.set(token, session);
  persistAdminSessions();
  return session;
}

async function loadAuthUsers() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const payload = JSON.parse(await fs.readFile(authUsersPath, "utf8"));
    return Array.isArray(payload.users) ? payload.users : [];
  } catch (error) {
    const seedUsers = [
      {
        mobile: "9876543210",
        email: "demo@gemplex.local",
        name: "Gemplex Demo",
        createdAt: new Date().toISOString()
      }
    ];
    await saveAuthUsers(seedUsers);
    return seedUsers;
  }
}

async function saveAuthUsers(users) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(authUsersPath, JSON.stringify({ users }, null, 2));
}

function normalizeMobileDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function mobileMatches(storedMobile, requestedMobile) {
  const stored = normalizeMobileDigits(storedMobile);
  const requested = normalizeMobileDigits(requestedMobile);
  if (!stored || !requested) return false;
  if (stored === requested) return true;
  return stored.length >= 10 && requested.length >= 10 && stored.slice(-10) === requested.slice(-10);
}

async function findUserByMobile(mobile) {
  const users = await loadAuthUsers();
  return users.find((user) => mobileMatches(user.mobile, mobile)) || null;
}

async function createUser({ mobile, email, name }) {
  const users = await loadAuthUsers();
  const existing = users.find((user) => user.mobile === mobile || user.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return existing;
  }

  const user = {
    mobile,
    email,
    name: name || "Gemplex Member",
    createdAt: new Date().toISOString()
  };
  users.push(user);
  await saveAuthUsers(users);
  return user;
}

function getSession(request) {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const session = activeSessions.get(token);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    activeSessions.delete(token);
    return null;
  }

  return session;
}

function getAdminSession(request) {
  const token = getBearerToken(request);
  if (!token) {
    return null;
  }

  const session = activeAdminSessions.get(token);
  if (!session) {
    return null;
  }

  if (new Date(session.expiresAt).getTime() < Date.now()) {
    activeAdminSessions.delete(token);
    persistAdminSessions();
    return null;
  }

  return session;
}

function requireAdmin(request, response) {
  const session = getAdminSession(request);
  if (!session) {
    sendJson(response, 401, { error: "Admin login required." });
    return null;
  }

  return session;
}

function sendJson(response, statusCode, payload, request = null) {
  const headers = {
    ...getSecurityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
  };

  if (request) {
    headers["Access-Control-Allow-Origin"] = getOriginHeader(request);
    headers.Vary = "Origin";
  }

  response.writeHead(statusCode, {
    ...headers
  });
  response.end(JSON.stringify(payload));
}

async function readRequestJson(request) {
  const chunks = [];
  let totalBytes = 0;
  const maxBytes = 15 * 1024 * 1024;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error("Request body is too large. Keep uploaded media smaller or use external media storage.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function readRequestBuffer(request, maxBytes) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error("Upload is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function sanitizeFileName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  const baseName = path.basename(fileName, extension)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "upload";
  return `${baseName}-${Date.now()}${extension}`;
}

function parseMultipartUpload(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Missing multipart boundary.");
    error.statusCode = 400;
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const parts = buffer.toString("latin1").split(`--${boundary}`);

  for (const part of parts) {
    if (!part.includes("filename=")) {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }

    const headerText = part.slice(0, headerEnd);
    let bodyText = part.slice(headerEnd + 4);
    bodyText = bodyText.replace(/\r\n--$/, "").replace(/\r\n$/, "");

    const fileNameMatch = headerText.match(/filename="([^"]+)"/i);
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const originalName = fileNameMatch?.[1] || "upload.bin";
    const mimeType = typeMatch?.[1]?.trim() || "application/octet-stream";

    return {
      originalName,
      mimeType,
      bytes: Buffer.from(bodyText, "latin1")
    };
  }

  const error = new Error("No file found in upload.");
  error.statusCode = 400;
  throw error;
}

async function saveUploadedMedia(request) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    const error = new Error("Expected multipart/form-data upload.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = await readRequestBuffer(request, 250 * 1024 * 1024);
  const upload = parseMultipartUpload(buffer, contentType);
  const extension = path.extname(upload.originalName).toLowerCase();
  if (!allowedUploadExtensions.has(extension)) {
    const error = new Error("This file type is not allowed.");
    error.statusCode = 415;
    throw error;
  }
  const safeName = sanitizeFileName(upload.originalName);
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(path.join(uploadsDir, safeName), upload.bytes);

  return {
    url: `/uploads/${safeName}`,
    fileName: safeName,
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    size: upload.bytes.length
  };
}

function toRelativeWebPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function getManagedRoot(rootName) {
  const key = String(rootName || "uploads").toLowerCase();
  const rootPath = fileManagerRoots[key];
  if (!rootPath) {
    const error = new Error("Unknown file manager folder.");
    error.statusCode = 400;
    throw error;
  }

  return { key, rootPath };
}

function resolveManagedPath(rootName, relativePath = "") {
  const { key, rootPath } = getManagedRoot(rootName);
  const cleanRelative = toRelativeWebPath(relativePath);
  const targetPath = path.resolve(rootPath, cleanRelative);
  const rootResolved = path.resolve(rootPath);

  if (targetPath !== rootResolved && !targetPath.startsWith(`${rootResolved}${path.sep}`)) {
    const error = new Error("File path is outside the allowed project folder.");
    error.statusCode = 403;
    throw error;
  }

  return { key, rootPath: rootResolved, targetPath, relativePath: cleanRelative };
}

function getManagedPublicUrl(rootName, relativePath) {
  if (!["uploads", "storage", "assets", "css", "js"].includes(rootName)) {
    return "";
  }

  const safePath = toRelativeWebPath(relativePath);
  return safePath ? `/${rootName}/${safePath}` : "";
}

async function listManagedFiles(rootName, relativePath = "") {
  const managed = resolveManagedPath(rootName, relativePath);
  await fs.mkdir(managed.rootPath, { recursive: true });
  await fs.mkdir(managed.targetPath, { recursive: true });

  const entries = await fs.readdir(managed.targetPath, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryRelative = toRelativeWebPath(path.join(managed.relativePath, entry.name));
    const entryPath = path.join(managed.targetPath, entry.name);
    const stats = await fs.stat(entryPath);
    const type = entry.isDirectory() ? "folder" : "file";

    return {
      name: entry.name,
      path: entryRelative,
      type,
      size: type === "file" ? stats.size : 0,
      modifiedAt: stats.mtime.toISOString(),
      url: type === "file" ? getManagedPublicUrl(managed.key, entryRelative) : ""
    };
  }));

  files.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    if (a.type === "file") {
      return new Date(b.modifiedAt || 0).getTime() - new Date(a.modifiedAt || 0).getTime()
        || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    root: managed.key,
    path: managed.relativePath,
    entries: files
  };
}

async function saveManagedFile(request, rootName, relativePath = "") {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    const error = new Error("Expected multipart/form-data upload.");
    error.statusCode = 400;
    throw error;
  }

  const managed = resolveManagedPath(rootName, relativePath);
  if (!writableFileRoots.has(managed.key)) {
    const error = new Error("This folder is read-only from the file manager.");
    error.statusCode = 403;
    throw error;
  }
  await fs.mkdir(managed.targetPath, { recursive: true });
  const buffer = await readRequestBuffer(request, 250 * 1024 * 1024);
  const upload = parseMultipartUpload(buffer, contentType);
  const extension = path.extname(upload.originalName).toLowerCase();
  if (!allowedUploadExtensions.has(extension)) {
    const error = new Error("This file type is not allowed.");
    error.statusCode = 415;
    throw error;
  }
  const safeName = sanitizeFileName(upload.originalName);
  const finalPath = path.join(managed.targetPath, safeName);
  await fs.writeFile(finalPath, upload.bytes);
  staticCache.clear();

  const savedRelative = toRelativeWebPath(path.join(managed.relativePath, safeName));
  return {
    root: managed.key,
    path: savedRelative,
    url: getManagedPublicUrl(managed.key, savedRelative),
    fileName: safeName,
    originalName: upload.originalName,
    mimeType: upload.mimeType,
    size: upload.bytes.length
  };
}

async function deleteManagedFile(rootName, relativePath) {
  const managed = resolveManagedPath(rootName, relativePath);
  if (!writableFileRoots.has(managed.key)) {
    const error = new Error("This folder is read-only from the file manager.");
    error.statusCode = 403;
    throw error;
  }

  if (!managed.relativePath) {
    const error = new Error("Choose a file or folder before deleting.");
    error.statusCode = 400;
    throw error;
  }

  await fs.rm(managed.targetPath, { recursive: true, force: true });
  const cleanup = await removeDeletedFileFromContent(managed.key, managed.relativePath);
  staticCache.clear();
  return { ok: true, root: managed.key, path: managed.relativePath, removedItems: cleanup.removedItems };
}

function normalizeMediaUrl(value) {
  return String(value || "").split("?")[0].replace(/\\/g, "/");
}

async function removeDeletedFileFromContent(rootName, relativePath) {
  const content = await getContent();
  const items = content?.mediaLibrary?.items;
  if (!Array.isArray(items)) {
    return { removedItems: [] };
  }

  const publicUrl = normalizeMediaUrl(getManagedPublicUrl(rootName, relativePath));
  const deletedPath = normalizeMediaUrl(relativePath);
  const isFolderDelete = !path.extname(relativePath);
  const removedItems = [];
  const nextItems = items.filter((item) => {
    const thumbnail = normalizeMediaUrl(item.thumbnail);
    const mediaSrc = normalizeMediaUrl(item.mediaSrc);
    const matchesFile = [thumbnail, mediaSrc].some((value) => (
      value === publicUrl ||
      value.endsWith(`/${deletedPath}`) ||
      (isFolderDelete && (value.startsWith(`${publicUrl}/`) || value.includes(`/${deletedPath}/`)))
    ));

    if (matchesFile) {
      removedItems.push({ id: item.id, title: item.title });
    }

    return !matchesFile;
  });

  if (removedItems.length) {
    await saveContent({
      ...content,
      mediaLibrary: {
        ...content.mediaLibrary,
        items: nextItems
      }
    });
  }

  return { removedItems };
}

async function ensureFallbackStore() {
  await fs.mkdir(dataDir, { recursive: true });
}

async function loadFallbackContent() {
  if (fallbackContentCache) {
    return fallbackContentCache;
  }

  try {
    fallbackContentCache = JSON.parse(await fs.readFile(fallbackContentPath, "utf8"));
    return fallbackContentCache;
  } catch (error) {
    return null;
  }
}

async function saveFallbackContent(content) {
  await ensureFallbackStore();
  fallbackContentCache = content;
  await fs.writeFile(fallbackContentPath, JSON.stringify(content, null, 2));
}

async function tryCreateMySqlPool() {
  let mysql;
  try {
    mysql = require("mysql2/promise");
  } catch (error) {
    mysqlStatus = "mysql2 package not installed; using file fallback";
    return;
  }

  const baseConfig = {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    connectTimeout: 2000
  };

  try {
    const connection = await mysql.createConnection(baseConfig);
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
       CHARACTER SET utf8mb4
       COLLATE utf8mb4_unicode_ci`
    );
    await connection.end();

    pool = mysql.createPool({
      ...baseConfig,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10
    });

    await ensureTables();
    mysqlStatus = "connected";
  } catch (error) {
    pool = null;
    mysqlStatus = `mysql unavailable: ${error.message}`;
  }
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cms_content (
      id VARCHAR(64) PRIMARY KEY,
      content_json JSON NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_uploads (
      id VARCHAR(128) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(80) NOT NULL,
      creator VARCHAR(160) NOT NULL,
      city VARCHAR(120) NOT NULL,
      status ENUM('published', 'draft', 'scheduled') NOT NULL DEFAULT 'draft',
      thumbnail LONGTEXT,
      media_src LONGTEXT,
      media_type VARCHAR(40) NOT NULL DEFAULT 'video',
      duration VARCHAR(32),
      views_label VARCHAR(40),
      created_at DATE,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

function normalizeContentRow(row) {
  if (!row) {
    return null;
  }

  return typeof row.content_json === "string" ? JSON.parse(row.content_json) : row.content_json;
}

async function syncUploads(content) {
  if (!pool) {
    return;
  }

  const uploads = content?.mediaLibrary?.items || [];
  const ids = uploads.map((item) => item.id);

  if (ids.length) {
    await pool.query("DELETE FROM media_uploads WHERE id NOT IN (?)", [ids]);
  } else {
    await pool.query("DELETE FROM media_uploads");
  }

  for (const item of uploads) {
    await pool.query(
      `INSERT INTO media_uploads (
        id, title, description, category, creator, city, status, thumbnail,
        media_src, media_type, duration, views_label, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        description = VALUES(description),
        category = VALUES(category),
        creator = VALUES(creator),
        city = VALUES(city),
        status = VALUES(status),
        thumbnail = VALUES(thumbnail),
        media_src = VALUES(media_src),
        media_type = VALUES(media_type),
        duration = VALUES(duration),
        views_label = VALUES(views_label),
        created_at = VALUES(created_at)`,
      [
        item.id,
        item.title,
        item.description,
        item.category,
        item.creator,
        item.city,
        item.status,
        item.thumbnail,
        item.mediaSrc,
        item.mediaType || "video",
        item.duration,
        item.views,
        item.createdAt || null
      ]
    );
  }
}

async function getContent() {
  if (pool) {
    const [rows] = await pool.query("SELECT content_json FROM cms_content WHERE id = ?", [contentId]);
    return normalizeContentRow(rows[0]);
  }

  return loadFallbackContent();
}

async function saveContent(content) {
  if (pool) {
    await pool.query(
      `INSERT INTO cms_content (id, content_json)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE content_json = VALUES(content_json)`,
      [contentId, JSON.stringify(content)]
    );
    await syncUploads(content);
    return;
  }

  await saveFallbackContent(content);
}

async function handleApi(request, response, pathname) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {}, request);
    return true;
  }

  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, storage: pool ? "mysql" : "fallback" }, request);
    return true;
  }

  if (pathname === "/api/admin/login" && request.method === "POST") {
    if (!checkRateLimit(request, "admin-login", 8, 15 * 60 * 1000)) {
      sendJson(response, 429, { error: "Too many login attempts. Try again later." }, request);
      return true;
    }

    const payload = await readRequestJson(request);
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");

    if (!adminEmail || !adminPassword) {
      sendJson(response, 503, { error: "Admin credentials are not configured on the server." }, request);
      return true;
    }

    if (email !== adminEmail || password !== adminPassword) {
      sendJson(response, 401, { error: "Only Gemplex admins can access this panel." }, request);
      return true;
    }

    const session = createAdminSession(email);
    sendJson(response, 200, { ok: true, session }, request);
    return true;
  }

  if (pathname === "/api/admin/session" && request.method === "GET") {
    const session = getAdminSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Admin login required." }, request);
      return true;
    }

    sendJson(response, 200, { ok: true, session }, request);
    return true;
  }

  if (pathname === "/api/admin/logout" && request.method === "POST") {
    const token = getBearerToken(request);
    if (token) {
      activeAdminSessions.delete(token);
      persistAdminSessions();
    }
    sendJson(response, 200, { ok: true }, request);
    return true;
  }

  if (pathname === "/api/content" && request.method === "GET") {
    sendJson(response, 200, { content: await getContent() });
    return true;
  }

  if (pathname === "/api/content" && request.method === "PUT") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const payload = await readRequestJson(request);
    if (!payload.content || typeof payload.content !== "object") {
      sendJson(response, 400, { error: "Request body must include a content object." });
      return true;
    }

    await saveContent(payload.content);
    sendJson(response, 200, { ok: true, content: payload.content });
    return true;
  }

  if (pathname === "/api/content/reset" && request.method === "POST") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const payload = await readRequestJson(request);
    if (!payload.content || typeof payload.content !== "object") {
      sendJson(response, 400, { error: "Request body must include a content object." });
      return true;
    }

    await saveContent(payload.content);
    sendJson(response, 200, { ok: true, content: payload.content });
    return true;
  }

  if (pathname === "/api/uploads" && request.method === "GET") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    if (pool) {
      const [rows] = await pool.query("SELECT * FROM media_uploads ORDER BY updated_at DESC");
      sendJson(response, 200, { uploads: rows });
      return true;
    }

    const content = await loadFallbackContent();
    sendJson(response, 200, { uploads: content?.mediaLibrary?.items || [] });
    return true;
  }

  if (pathname === "/api/media" && request.method === "POST") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const upload = await saveUploadedMedia(request);
    sendJson(response, 200, { ok: true, upload });
    return true;
  }

  if (pathname === "/api/files" && request.method === "GET") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const root = url.searchParams.get("root") || "uploads";
    const currentPath = url.searchParams.get("path") || "";
    sendJson(response, 200, await listManagedFiles(root, currentPath));
    return true;
  }

  if (pathname === "/api/files/upload" && request.method === "POST") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const root = url.searchParams.get("root") || "uploads";
    const currentPath = url.searchParams.get("path") || "";
    const upload = await saveManagedFile(request, root, currentPath);
    sendJson(response, 200, { ok: true, upload });
    return true;
  }

  if (pathname === "/api/files" && request.method === "DELETE") {
    if (!requireAdmin(request, response)) {
      return true;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const root = url.searchParams.get("root") || "uploads";
    const currentPath = url.searchParams.get("path") || "";
    sendJson(response, 200, await deleteManagedFile(root, currentPath));
    return true;
  }

  if (pathname === "/api/auth/request-otp" && request.method === "POST") {
    if (!checkRateLimit(request, "otp", 5, 10 * 60 * 1000)) {
      sendJson(response, 429, { error: "Too many OTP requests. Try again later." }, request);
      return true;
    }

    const payload = await readRequestJson(request);
    const mobile = String(payload.mobile || "").replace(/\D/g, "");
    if (mobile.length < 10 || mobile.length > 13) {
      sendJson(response, 400, { error: "Enter a valid mobile number." });
      return true;
    }

    const user = await findUserByMobile(mobile);
    if (!user) {
      sendJson(response, 200, {
        ok: true,
        exists: false,
        mobile,
        message: "This mobile number is not registered. Continue with email to create an account."
      });
      return true;
    }

    const otp = String(crypto.randomInt(100000, 999999));
    pendingOtps.set(mobile, {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000,
      attempts: 0
    });

    sendJson(response, 200, {
      ok: true,
      exists: true,
      mobile,
      expiresInSeconds: 300,
      message: "OTP sent if this number is registered."
    });
    return true;
  }

  if (pathname === "/api/auth/register-start" && request.method === "POST") {
    if (!checkRateLimit(request, "signup", 5, 10 * 60 * 1000)) {
      sendJson(response, 429, { error: "Too many signup requests. Try again later." }, request);
      return true;
    }

    const payload = await readRequestJson(request);
    const mobile = String(payload.mobile || "").replace(/\D/g, "");
    const email = String(payload.email || "").trim().toLowerCase();

    if (mobile.length < 10 || mobile.length > 13) {
      sendJson(response, 400, { error: "Enter a valid mobile number." });
      return true;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJson(response, 400, { error: "Enter a valid email address." });
      return true;
    }

    const existing = await findUserByMobile(mobile);
    if (existing) {
      sendJson(response, 409, { error: "This mobile number already has an account. Use OTP login." });
      return true;
    }

    const signupToken = createToken();
    pendingSignups.set(signupToken, {
      mobile,
      email,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    sendJson(response, 200, {
      ok: true,
      email,
      message: "Account creation email sent if the address can receive Gemplex mail."
    });
    return true;
  }

  if (pathname === "/api/auth/register-complete" && request.method === "POST") {
    const payload = await readRequestJson(request);
    const token = String(payload.token || "");
    const name = String(payload.name || "").trim();
    const pending = pendingSignups.get(token);

    if (!pending || pending.expiresAt < Date.now()) {
      pendingSignups.delete(token);
      sendJson(response, 400, { error: "Signup link expired. Start again." });
      return true;
    }

    const user = await createUser({
      mobile: pending.mobile,
      email: pending.email,
      name
    });
    pendingSignups.delete(token);
    const session = createSession(user.mobile);
    sendJson(response, 200, { ok: true, user, session });
    return true;
  }

  if (pathname === "/api/auth/verify-otp" && request.method === "POST") {
    const payload = await readRequestJson(request);
    const mobile = String(payload.mobile || "").replace(/\D/g, "");
    const otp = String(payload.otp || "").trim();
    const pending = pendingOtps.get(mobile);

    if (!pending || pending.expiresAt < Date.now()) {
      pendingOtps.delete(mobile);
      sendJson(response, 400, { error: "OTP expired. Request a new OTP." });
      return true;
    }

    pending.attempts += 1;
    if (pending.attempts > 5) {
      pendingOtps.delete(mobile);
      sendJson(response, 429, { error: "Too many OTP attempts. Request a new OTP." });
      return true;
    }

    if (pending.otp !== otp) {
      sendJson(response, 401, { error: "Incorrect OTP." });
      return true;
    }

    pendingOtps.delete(mobile);
    const session = createSession(mobile);
    sendJson(response, 200, { ok: true, session });
    return true;
  }

  if (pathname === "/api/auth/session" && request.method === "GET") {
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { error: "Login required." });
      return true;
    }

    sendJson(response, 200, { ok: true, session });
    return true;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = getBearerToken(request);
    if (token) {
      activeSessions.delete(token);
    }
    sendJson(response, 200, { ok: true });
    return true;
  }

  return false;
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

async function serveStatic(response, pathname) {
  if (pathname === "/index.html/admin" || pathname === "/index/admin" || pathname === "/admin") {
    pathname = "/admin.html";
  }

  pathname = pathname
    .replace(/^\/index\.html\/(css|js|assets)\//, "/$1/")
    .replace(/^\/index\/(css|js|assets)\//, "/$1/")
    .replace(/^\/admin\/(css|js|assets)\//, "/$1/");

  const bareAssetAliases = {
    "/styles.css": "/css/styles.css",
    "/content-store.js": "/js/content-store.js",
    "/script.js": "/js/script.js",
    "/admin-app.js": "/js/admin-app.js"
  };

  pathname = bareAssetAliases[pathname] || pathname;

  const safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let filePath;
  const rootHtmlFiles = new Set([
    "index.html",
    "admin.html",
    "details.html",
    "login.html",
    "otp.html",
    "create-account.html",
    "app-download.html"
  ]);

  if (safePath === "" || safePath === ".") {
    filePath = path.join(rootDir, "index.html");
  } else if (rootHtmlFiles.has(safePath)) {
    filePath = path.join(rootDir, safePath);
  } else {
    const [topLevelFolder, ...rest] = safePath.split(/[\\/]+/);
    const allowedRoot = publicStaticRoots.get(topLevelFolder);
    if (!allowedRoot || protectedStaticNames.has(safePath) || topLevelFolder === "data") {
      response.writeHead(404, getSecurityHeaders());
      response.end("Not found");
      return;
    }
    filePath = path.join(allowedRoot, rest.join(path.sep));
  }

  const allowedStaticRoots = [
    rootDir,
    ...Array.from(publicStaticRoots.values())
  ].map((item) => path.resolve(item));
  const resolvedFilePath = path.resolve(filePath);
  const isAllowedPath = allowedStaticRoots.some((allowedRoot) => (
    resolvedFilePath === allowedRoot || resolvedFilePath.startsWith(`${allowedRoot}${path.sep}`)
  ));

  if (!isAllowedPath) {
    response.writeHead(403, getSecurityHeaders());
    response.end("Forbidden");
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
  } catch (error) {
    response.writeHead(404, getSecurityHeaders());
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const cacheable = ![".html", ".json", ".mp4", ".mov", ".webm"].includes(extension);
  const cacheKey = filePath;
  const fileStat = await fs.stat(filePath);
  let data;

  if (cacheable) {
    const cached = staticCache.get(cacheKey);
    if (cached && cached.mtimeMs === fileStat.mtimeMs) {
      data = cached.data;
    } else {
      data = await fs.readFile(filePath);
      staticCache.set(cacheKey, { data, mtimeMs: fileStat.mtimeMs });
    }
  } else {
    data = await fs.readFile(filePath);
  }

  response.writeHead(200, {
    ...getSecurityHeaders(),
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": cacheable ? "public, max-age=3600, immutable" : "no-store"
  });
  response.end(data);
}

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname || "/";

    if (pathname.startsWith("/api/") && await handleApi(request, response, pathname)) {
      return;
    }

    await serveStatic(response, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? "Internal server error." : error.message;
    sendJson(response, statusCode, { error: message }, request);
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the existing Gemplex server or set PORT to another value.`);
    process.exitCode = 1;
    return;
  }
  console.error("Gemplex server failed:", error.message);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Gemplex CMS server running at http://localhost:${port}`);
  console.log("Storage: file fallback while MySQL initializes");
});

tryCreateMySqlPool().then(() => {
  console.log(`Storage: ${pool ? "MySQL" : "file fallback"} (${mysqlStatus})`);
}).catch((error) => {
  mysqlStatus = `mysql unavailable: ${error.message}`;
  console.log(`Storage: file fallback (${mysqlStatus})`);
});
