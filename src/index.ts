import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@libsql/client/web'

type Bindings = {
  TURSO_DATABASE_URL: string
  TURSO_AUTH_TOKEN: string
  ADMIN_SECRET: string
}

type Variables = {
  gameId: string
  secretKey: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/*', cors())

// --- HELPER: DATABASE CONNECTION ---
const getDb = (env: Bindings) => {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  })
}

// --- HELPER: SECURITY (HMAC-SHA256) ---
async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(body);

  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const signatureBytes = new Uint8Array(
    signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
  );

  return await crypto.subtle.verify("HMAC", key, signatureBytes, msgData);
}

// ==========================================
// ENDPOINT 0: ADMIN - CREATE GAME & LEADERBOARD (PROTECTED)
// ==========================================
const admin = app.basePath('/admin')
admin.use('/*', async (c, next) => {
  const adminSecret = c.req.header('x-admin-secret')
  if (adminSecret !== c.env.ADMIN_SECRET) {
    return c.json({ success: false, error: 'Unauthorized: Wrong Admin Secret' }, 401)
  }
  await next()
})


admin.get('/games', async (c) => {
  const db = getDb(c.env)
  try {
    const result = await db.execute({
      sql: `
        SELECT
          g.id AS game_id,
          g.name,
          g.api_key,
          g.secret_key, -- TAMBAHKAN INI
          g.created_at,
          COUNT(b.id) AS board_count
        FROM games g
        LEFT JOIN boards b ON b.game_id = g.id
        GROUP BY g.id, g.name, g.api_key, g.secret_key, g.created_at -- TAMBAHKAN JUGA DI SINI
        ORDER BY g.created_at DESC
      `,
    })

    return c.json({
      success: true,
      data: result.rows.map((row) => ({
        gameId: row.game_id,
        name: row.name,
        apiKey: row.api_key,
        secretKey: row.secret_key,
        createdAt: row.created_at,
        boardCount: Number(row.board_count || 0),
      })),
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

admin.get('/games/:gameId/boards', async (c) => {
  const db = getDb(c.env)
  const gameId = c.req.param('gameId')

  try {
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE id = ?',
      args: [gameId],
    })

    if (gameRes.rows.length === 0) {
      return c.json({ success: false, error: 'Game not found' }, 404)
    }

    const result = await db.execute({
      sql: `
        SELECT
          id AS board_id,
          slug,
          name,
          order_mode,
          created_at
        FROM boards
        WHERE game_id = ?
        ORDER BY created_at DESC
      `,
      args: [gameId],
    })

    return c.json({
      success: true,
      data: result.rows.map((row) => ({
        boardId: row.board_id,
        slug: row.slug,
        name: row.name,
        orderMode: row.order_mode,
        createdAt: row.created_at,
      })),
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})


admin.post('/games', async (c) => {
  const db = getDb(c.env)
  const { name } = await c.req.json()

  if (!name) return c.json({ error: 'Game name is required' }, 400)

  const gameId = crypto.randomUUID()
  const newApiKey = crypto.randomUUID()
  const newSecretKey = crypto.randomUUID() + '-' + crypto.randomUUID()

  try {
    await db.execute({
      sql: 'INSERT INTO games (id, name, api_key, secret_key) VALUES (?, ?, ?, ?)',
      args: [gameId, name, newApiKey, newSecretKey]
    })

    return c.json({
      success: true,
      message: 'Game created successfully',
      data: {
        gameId,
        name,
        apiKey: newApiKey,
        secretKey: newSecretKey
      }
    })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

admin.post('/boards', async (c) => {
  const db = getDb(c.env)
  const { apiKey, slug, name, orderMode } = await c.req.json()

  if (!apiKey || !slug || !name) {
    return c.json({ error: 'Missing fields: apiKey, slug, name' }, 400)
  }

  const mode = orderMode === 'ASC' ? 'ASC' : 'DESC' 

  try {
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE api_key = ?',
      args: [apiKey]
    })

    if (gameRes.rows.length === 0) return c.json({ error: 'Game not found' }, 404)
    const gameId = gameRes.rows[0].id

    const boardId = crypto.randomUUID()

    await db.execute({
      sql: 'INSERT INTO boards (id, game_id, slug, name, order_mode) VALUES (?, ?, ?, ?, ?)',
      args: [boardId, gameId, slug, name, mode]
    })

    return c.json({
      success: true,
      message: `Leaderboard '${slug}' created`,
      data: { boardId, slug, mode }
    })
  } catch (e: any) {
    if (e.message.includes('UNIQUE constraint failed')) {
        return c.json({ success: false, error: 'Board slug already exists for this game' }, 409)
    }
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ==========================================
// ENDPOINT 1: SUBMIT SCORE (SECURE & ATOMIC)
// ==========================================

app.post('/v1/start', async (c) => {
  const db = getDb(c.env)
  const apiKey = c.req.header('x-game-key')

  // 1. Pastikan Header Dikirim
  if (!apiKey) {
    return c.json({ success: false, error: 'Missing Auth Header (x-game-key)' }, 401)
  }

  try {
    // 2. Validasi Game Key ke Database Turso
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE api_key = ?',
      args: [apiKey]
    })

    if (gameRes.rows.length === 0) {
      return c.json({ success: false, error: 'Invalid Game Key' }, 403)
    }

    const gameId = gameRes.rows[0].id

    // 3. Generate Tiket Sesi (Token Unik)
    const token = crypto.randomUUID()

    // 4. Siapkan Data Sesi
    const sessionData = {
      startTime: Date.now(),
      gameId: gameId
    }

    // 5. Simpan ke Cloudflare KV (TTL 1 Jam = 3600 Detik)
    // Setelah 1 jam, Cloudflare otomatis menghapus tiket ini (bebas sampah)
    await c.env.LEADERBOARD_SESSIONS.put(token, JSON.stringify(sessionData), { expirationTtl: 3600 })

    // 6. Kirim Tiket kembali ke Game (Unity)
    return c.json({ success: true, sessionToken: token })

  } catch (e: any) {
    console.error("Start Session Error:", e)
    return c.json({ success: false, error: e.message }, 500)
  }
})

app.post('/v1/submit', async (c) => {
  const db = getDb(c.env)
  
  const apiKey = c.req.header('x-game-key')

  if (!apiKey) {
    return c.json({ success: false, error: 'Missing Auth Header (x-game-key)' }, 401)
  }

  try {
    const rawBody = await c.req.text()
    const payload = JSON.parse(rawBody)
    
    // 1. TERIMA SESSION TOKEN DARI UNITY
    const { playerId, username, avatarUrl, boardSlug, score, metadata, sessionToken } = payload

    if (!playerId || !boardSlug || score === undefined || !sessionToken) {
      return c.json({ success: false, error: 'Missing required fields (including sessionToken)' }, 400)
    }

    // ==========================================
    // FASE WASIT: VALIDASI TIKET DI CLOUDFLARE KV
    // ==========================================
    const sessionRaw = await c.env.LEADERBOARD_SESSIONS.get(sessionToken)
    
    if (!sessionRaw) {
      // Ubah pesan error agar lebih ramah, karena bisa jadi ini karena token expired, bukan murni cheater
      return c.json({ success: false, error: 'Invalid or Expired Session Token. Please restart the game.' }, 403)
    }

    // 2. HANGUSKAN TIKET (ANTI REPLAY-ATTACK)
    // Tiket langsung dihapus agar 1 token hanya bisa dipakai 1x kirim skor
    await c.env.LEADERBOARD_SESSIONS.delete(sessionToken)

    // ==========================================
    // FASE DATABASE: SIMPAN KE TURSO
    // ==========================================

    // 3. Ambil Game ID
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE api_key = ?',
      args: [apiKey]
    })

    if (gameRes.rows.length === 0) {
      return c.json({ success: false, error: 'Invalid Game Key' }, 403)
    }

    const gameId = gameRes.rows[0].id as string
    const internalPlayerId = `${gameId}_${playerId}` 
    
    // 4. Update / Insert Data Player
    await db.execute({
      sql: `
        INSERT INTO players (id, game_id, external_id, display_name, avatar_url, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, external_id) DO UPDATE SET
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          metadata = excluded.metadata,
          created_at = created_at
      `,
      args: [
        internalPlayerId, 
        gameId, 
        playerId, 
        username || 'Unknown', 
        avatarUrl || '', 
        JSON.stringify(metadata || {})
      ]
    })

    // 5. Cari Board
    const boardRes = await db.execute({
      sql: 'SELECT id, order_mode FROM boards WHERE game_id = ? AND slug = ?',
      args: [gameId, boardSlug]
    })

    if (boardRes.rows.length === 0) {
      if (boardSlug === 'global') {
          return c.json({ success: false, error: 'Leaderboard not found. Please create it in DB first.' }, 404)
      }
      return c.json({ success: false, error: 'Leaderboard not found' }, 404)
    }

    const board = boardRes.rows[0]
    const boardId = board.id as string
    const isDesc = board.order_mode === 'DESC'

    // 6. Cek Skor Lama
    const entryRes = await db.execute({
      sql: 'SELECT score FROM entries WHERE board_id = ? AND player_id = ?',
      args: [boardId, internalPlayerId]
    })

    let shouldUpdate = false
    const newScore = Number(score)

    if (entryRes.rows.length === 0) {
      shouldUpdate = true
    } else {
      const oldScore = Number(entryRes.rows[0].score)
      if (isDesc && newScore > oldScore) shouldUpdate = true
      if (!isDesc && newScore < oldScore) shouldUpdate = true
    }

    // 7. Simpan Skor Baru Jika Lebih Baik
    if (shouldUpdate) {
      await db.execute({
        sql: `
          INSERT INTO entries (board_id, player_id, score, metadata, submission_count, updated_at)
          VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
          ON CONFLICT(board_id, player_id) DO UPDATE SET
            score = excluded.score,
            metadata = excluded.metadata,
            submission_count = entries.submission_count + 1,
            updated_at = CURRENT_TIMESTAMP
        `,
        args: [boardId, internalPlayerId, newScore, JSON.stringify(metadata || {})]
      })
      return c.json({ success: true, status: 'updated', message: 'New record!' })
    } else {
      return c.json({ success: true, status: 'kept_old', message: 'Previous score was better' })
    }

  } catch (e: any) {
    console.error(e)
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ==========================================
// ENDPOINT 2: GET LEADERBOARD (PUBLIC READ)
// ==========================================
app.get('/v1/boards/:slug', async (c) => {
  const db = getDb(c.env)
  const apiKey = c.req.header('x-game-key')
  const slug = c.req.param('slug')
  
  // Ambil parameter dari Unity
  const limit = c.req.query('limit') || '100'
  const playerId = c.req.query('playerId') // ID Device player saat ini

  if (!apiKey) return c.json({ error: 'Missing x-game-key' }, 401)

  try {
    const gameRes = await db.execute({
      sql: 'SELECT id FROM games WHERE api_key = ?',
      args: [apiKey]
    })
    
    if (gameRes.rows.length === 0) return c.json({ error: 'Invalid Game Key' }, 403)
    const gameId = gameRes.rows[0].id

    const boardRes = await db.execute({
        sql: 'SELECT id, order_mode FROM boards WHERE game_id = ? AND slug = ?',
        args: [gameId, slug]
    })
    
    if (boardRes.rows.length === 0) return c.json({ data: [] })
    
    const boardId = boardRes.rows[0].id
    const orderMode = boardRes.rows[0].order_mode

    // 1. AMBIL TOP X (Misal: 100)
    const query = `
      SELECT 
        p.external_id as id,
        p.display_name as username, 
        p.avatar_url, 
        e.score, 
        e.metadata
      FROM entries e
      JOIN players p ON e.player_id = p.id
      WHERE e.board_id = ?
      ORDER BY e.score ${orderMode}
      LIMIT ?
    `
    const result = await db.execute({ sql: query, args: [boardId, limit] })

    const formattedTop = result.rows.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      username: row.username,
      score: row.score
    }))

    // 2. CARI POSISI SPESIFIK PLAYER (Jika dia minta)
    let playerEntry = null;
    if (playerId) {
      // Cek apakah player sudah ada di dalam Top 100
      playerEntry = formattedTop.find(p => p.id === playerId);

      // Jika TIDAK ADA di Top 100, hitung manual posisinya di database
      if (!playerEntry) {
        const internalPlayerId = `${gameId}_${playerId}`;
        const pRes = await db.execute({
          sql: `SELECT p.display_name, e.score FROM entries e JOIN players p ON e.player_id = p.id WHERE e.board_id = ? AND e.player_id = ?`,
          args: [boardId, internalPlayerId]
        });

        if (pRes.rows.length > 0) {
          const pScore = Number(pRes.rows[0].score);
          const op = orderMode === 'DESC' ? '>' : '<';
          
          // Hitung ada berapa orang yang skornya lebih besar dari player ini
          const rankRes = await db.execute({
            sql: `SELECT COUNT(*) as rank_above FROM entries WHERE board_id = ? AND score ${op} ?`,
            args: [boardId, pScore]
          });
          
          playerEntry = {
            rank: Number(rankRes.rows[0].rank_above) + 1,
            id: playerId,
            username: pRes.rows[0].display_name,
            score: pScore
          }
        }
      }
    }

    // Kembalikan Top 100 + Data spesifik player
    return c.json({ success: true, data: formattedTop, playerEntry: playerEntry })

  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})


// ==========================================
// ENDPOINT: DELETE GAME
// ==========================================
admin.delete('/games/:gameId', async (c) => {
  const db = getDb(c.env)
  const gameId = c.req.param('gameId')

  try {
    await db.execute({ sql: 'DELETE FROM entries WHERE board_id IN (SELECT id FROM boards WHERE game_id = ?)', args: [gameId] })
    await db.execute({ sql: 'DELETE FROM boards WHERE game_id = ?', args: [gameId] })
    await db.execute({ sql: 'DELETE FROM players WHERE game_id = ?', args: [gameId] })
    const res = await db.execute({ sql: 'DELETE FROM games WHERE id = ?', args: [gameId] })

    if (res.rowsAffected === 0) {
      return c.json({ success: false, error: 'Game not found' }, 404)
    }

    return c.json({ success: true, message: 'Game and all related data deleted successfully' })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

// ==========================================
// ENDPOINT: DELETE BOARD
// ==========================================
admin.delete('/boards/:boardId', async (c) => {
  const db = getDb(c.env)
  const boardId = c.req.param('boardId')

  try {
    await db.execute({ sql: 'DELETE FROM entries WHERE board_id = ?', args: [boardId] })
    const res = await db.execute({ sql: 'DELETE FROM boards WHERE id = ?', args: [boardId] })

    if (res.rowsAffected === 0) {
      return c.json({ success: false, error: 'Board not found' }, 404)
    }

    return c.json({ success: true, message: 'Leaderboard deleted successfully' })
  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500)
  }
})

export default app