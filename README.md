# 🏆 Leaderboard API Serverless

API leaderboard berkinerja tinggi, aman, dan scalable yang dibangun menggunakan **Hono**, **Cloudflare Workers**, dan **Turso (LibSQL)**.

Proyek ini memungkinkan Anda untuk mengelola sistem skor (leaderboard) untuk banyak game sekaligus, dengan fitur keamanan validasi signature (HMAC-SHA256) untuk mencegah kecurangan saat submit skor.

## ✨ Fitur Utama

- **Serverless**: Dideploy di Cloudflare Workers (Global Low Latency).
- **Multi-Game Support**: Satu API bisa menangani banyak game dengan `apiKey` publik dan `secretKey` privat untuk tiap game.
- **Secure Submission**: Menggunakan validasi HMAC-SHA256 untuk memastikan skor yang dikirim valid dan tidak diubah di tengah jalan.
- **Atomic Updates**: Skor hanya diperbarui jika lebih baik dari sebelumnya (High Score) atau sesuai mode urutan (ASC/DESC).
- **Metadata Support**: Bisa menyimpan data tambahan (JSON) pada player atau entry skor (misal: replay data, loadout, dll).
- **Database**: Menggunakan Turso (SQLite over HTTP) yang ringan dan cepat.

## 🛠️ Tech Stack

- [Hono](https://hono.dev/) - Web Framework super cepat.
- [Cloudflare Workers](https://workers.cloudflare.com/) - Platform Serverless.
- [Turso](https://turso.tech/) - Database SQLite terdistribusi (LibSQL).
- [TypeScript](https://www.typescriptlang.org/) - Bahasa pemrograman.

---

## 🚀 Persiapan & Instalasi

### 1. Prasyarat

Pastikan Anda sudah menginstal:
- [Node.js](https://nodejs.org/) (v18 atau lebih baru)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- Akun [Turso](https://turso.tech/) untuk database.

### 2. Clone & Install

```bash
git clone https://github.com/Whyriez/leaderboard-api-app.git
cd leaderboard-api
npm install
```

### 3. Setup Database (Turso)

Karena proyek ini menggunakan raw SQL, Anda perlu membuat tabel-tabel berikut di database Turso Anda.

Jalankan perintah SQL berikut di **Turso Shell**:

```sql
-- Tabel Games
CREATE TABLE games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    secret_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Boards (Leaderboard per Game)
CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    order_mode TEXT DEFAULT 'DESC', -- 'ASC' atau 'DESC'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id),
    UNIQUE(game_id, slug)
);

-- Tabel Players
CREATE TABLE players (
    id TEXT PRIMARY KEY, -- Format: gameId_playerId
    game_id TEXT NOT NULL,
    external_id TEXT NOT NULL, -- ID dari sisi klien (misal: UUID user)
    display_name TEXT,
    avatar_url TEXT,
    metadata TEXT, -- JSON String
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(game_id) REFERENCES games(id),
    UNIQUE(game_id, external_id)
);

-- Tabel Entries (Skor)
CREATE TABLE entries (
    board_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    score REAL NOT NULL,
    submission_count INTEGER DEFAULT 1,
    metadata TEXT, -- JSON String untuk detail skor
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(board_id) REFERENCES boards(id),
    FOREIGN KEY(player_id) REFERENCES players(id),
    UNIQUE(board_id, player_id)
);
```

### 4. Konfigurasi Environment

Untuk local development dengan `wrangler dev`, buat file `.dev.vars` lalu isi seperti ini:

```ini
TURSO_DATABASE_URL="libsql://nama-db-kamu.turso.io"
TURSO_AUTH_TOKEN="token-turso-kamu"
ADMIN_SECRET="kunci-rahasia-bebas-untuk-admin"
```

Kalau Anda ingin menyimpan contoh konfigurasi, pakai `.env.example` sebagai referensi nilai yang harus diisi. Saat deploy ke Cloudflare, simpan value sensitif dengan `wrangler secret put`.

> **Catatan:** `ADMIN_SECRET` adalah password sederhana yang Anda tentukan sendiri untuk mengakses endpoint pembuatan Game dan Board.

### 5. Istilah Kunci

Supaya tidak membingungkan, berikut mapping yang dipakai oleh kode ini:

| Istilah | Dipakai Di | Fungsi |
|---|---|---|
| `apiKey` | Response dari `POST /admin/games` | Identitas publik game |
| `x-game-key` | Header request client | Nilai yang sama dengan `apiKey` |
| `secretKey` | Response dari `POST /admin/games` | Secret privat untuk signing HMAC |
| `x-signature` | Header request client | Hasil HMAC-SHA256 dari body request |

`secretKey` sebaiknya disimpan di backend game, bukan di client publik. Kalau game Anda hanya punya frontend, proteksi signature akan tetap jalan secara teknis, tetapi secret-nya tidak benar-benar aman.

---

## 💻 Menjalankan Secara Lokal

Untuk menjalankan server development lokal:

```bash
npm run dev
```

Server akan berjalan di `http://localhost:8787`.

---

## ☁️ Deploy ke Cloudflare Workers

1.  **Login ke Cloudflare**:
    ```bash
    npx wrangler login
    ```

2.  **Set Environment Variables di Cloudflare**:
    Jangan upload file `.env`! Gunakan `wrangler secret` untuk menyimpan data sensitif di Cloudflare.

    ```bash
    npx wrangler secret put TURSO_DATABASE_URL
    # Masukkan URL database saat diminta
    
    npx wrangler secret put TURSO_AUTH_TOKEN
    # Masukkan Token database saat diminta
    
    npx wrangler secret put ADMIN_SECRET
    # Masukkan secret admin pilihan Anda
    ```

3.  **Deploy**:
    ```bash
    npm run deploy
    ```

API Anda sekarang online! 🌍

---

## 📖 API Documentation

### 👮 Admin Endpoints
*Membutuhkan header `x-admin-secret` yang sesuai dengan env `ADMIN_SECRET`.*

#### 1. Buat Game Baru
`POST /admin/games`

**Request:**
```json
{
  "name": "Super Jump 2026"
}
```

**Response:**
Simpan `apiKey` dan `secretKey` ini. `apiKey` dipakai sebagai `x-game-key`, sedangkan `secretKey` dipakai untuk signing request saat submit skor.
```json
{
  "success": true,
  "data": {
    "gameId": "uuid...",
    "name": "Super Jump 2026",
    "apiKey": "game-api-key-uuid", 
    "secretKey": "game-secret-key-uuid"
  }
}
```

#### 2. Buat Leaderboard
`POST /admin/boards`

**Request:**
* `slug`: ID unik leaderboard (misal: `global`, `weekly`, `hardcore`).
* `orderMode`: `DESC` (Skor tinggi menang) atau `ASC` (Waktu tercepat/skor rendah menang).

```json
{
  "apiKey": "game-api-key-uuid",
  "slug": "global",
  "name": "Global Ranking",
  "orderMode": "DESC"
}
```

---

### 🎮 Client / Game Endpoints

#### 1. Submit Score (Secure)
`POST /v1/submit`

Endpoint ini membutuhkan **HMAC-SHA256 Signature** untuk mencegah request palsu.

**Headers:**
* `Content-Type`: `application/json`
* `x-game-key`: `apiKey` game kamu dari `POST /admin/games`
* `x-signature`: `HEX_STRING_DARI_HMAC` dari raw JSON body, memakai `secretKey`

**Body (Raw JSON):**
```json
{
  "playerId": "user_123",
  "username": "JagoanNeon",
  "avatarUrl": "https://...",
  "boardSlug": "global",
  "score": 1500,
  "metadata": { "hero": "warrior", "stage": 5 }
}
```

**Logika Update:**
* Jika user belum ada di leaderboard -> Insert.
* Jika user sudah ada -> Update HANYA JIKA skor baru lebih baik (sesuai `orderMode`).

#### 2. Get Leaderboard
`GET /v1/boards/:slug?limit=50`

**Headers:**
* `x-game-key`: `apiKey` game kamu dari `POST /admin/games`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "rank": 1,
      "id": "user_123",
      "username": "JagoanNeon",
      "score": 1500,
      "avatarUrl": "...",
      "metadata": { "hero": "warrior" }
    },
    ...
  ]
}
```

---

## 🔐 Client-Side Implementation (Cara Generate Signature)

Berikut adalah contoh cara melakukan request submit score yang aman menggunakan JavaScript/TypeScript.

```typescript
async function submitScore(gameApiKey, gameSecretKey, data) {
  const body = JSON.stringify(data);
  
  // 1. Generate Signature (HMAC-SHA256)
  const encoder = new TextEncoder();
  const keyData = encoder.encode(gameSecretKey);
  const msgData = encoder.encode(body);

  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, msgData);
  
  // Convert buffer to Hex string
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // 2. Kirim Request
  const response = await fetch('[https://your-worker-url.workers.dev/v1/submit](https://your-worker-url.workers.dev/v1/submit)', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-game-key': gameApiKey,
      'x-signature': signature
    },
    body: body
  });

  return await response.json();
}

// Penggunaan
const payload = {
    playerId: "u1",
    username: "Alim",
    boardSlug: "global",
    score: 9999
};

submitScore("API_KEY_ANDA", "SECRET_KEY_ANDA", payload).then(console.log);
```

Untuk Unity, parameter `apiKey` pada contoh dokumentasi itu sama dengan `apiKey` yang dikirim server saat `POST /admin/games`. Kalau Anda ingin aman, `secretKey` jangan dimasukkan langsung ke client Unity; lebih baik request signing dilakukan di backend game Anda.

### 7. Contoh Node.js Lokal

File `test-client.js` di repo ini adalah contoh Node.js untuk mengetes submit score secara lokal. Jalankan dengan environment variable, bukan dengan hardcode:

```bash
API_URL=http://localhost:8787/v1/submit API_KEY=your_api_key SECRET_KEY=your_secret_key node test-client.js
```

Kalau Anda memakai backend produksi, arahkan `API_URL` ke URL worker yang sudah dideploy.

## 📄 Lisensi

Project ini dilisensikan di bawah [MIT License](LICENSE).
