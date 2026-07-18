import { createClient } from '@libsql/client/web'

export type Bindings = {
  TURSO_DATABASE_URL: string
  TURSO_AUTH_TOKEN: string
  ADMIN_SECRET: string
  LEADERBOARD_SESSIONS: KVNamespace
}

export const getDb = (env: Bindings) => {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  })
}