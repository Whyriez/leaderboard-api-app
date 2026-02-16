import { Context, Next } from 'hono'
import { getDb, Bindings } from './db'

export const gameAuth = async (c: Context<{ Bindings: Bindings }>, next: Next) => {
  const apiKey = c.req.header('x-game-key')

  if (!apiKey) {
    return c.json({ error: 'Missing x-game-key header' }, 401)
  }

  const db = getDb(c.env)
  
  // Cek apakah Game Key valid
  const result = await db.execute({
    sql: 'SELECT id FROM games WHERE api_key = ?',
    args: [apiKey]
  })

  if (result.rows.length === 0) {
    return c.json({ error: 'Invalid Game Key' }, 403)
  }

  // Simpan game_id ke context biar bisa dipakai di controller
  c.set('gameId', result.rows[0].id)

  await next()
}