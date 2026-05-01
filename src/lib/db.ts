import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Check if we're in an environment where SQLite DB is available
const isDbAvailable = () => {
  try {
    // On Vercel/serverless, the DB file path won't exist
    const dbUrl = process.env.DATABASE_URL || ''
    return dbUrl.startsWith('file:') ? process.env.VERCEL !== '1' : true
  } catch {
    return false
  }
}

let _db: PrismaClient | null = null

function getDb(): PrismaClient | null {
  if (!isDbAvailable()) return null
  if (!_db) {
    try {
      _db = globalForPrisma.prisma ?? new PrismaClient({ log: ['error', 'warn'] })
      if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = _db
    } catch {
      return null
    }
  }
  return _db
}

// Export a safe db wrapper that won't crash if DB is unavailable
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const realDb = getDb()
    if (!realDb) {
      // Return no-op functions that silently fail on Vercel
      return (..._args: unknown[]) => Promise.resolve(null)
    }
    return (realDb as Record<string, unknown>)[prop]
  }
})
