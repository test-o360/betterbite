/**
 * Database wrapper that is safe for Vercel serverless environments.
 *
 * SQLite is incompatible with Vercel's ephemeral filesystem.
 * This module uses dynamic imports so that a missing / broken Prisma
 * client binary never crashes the app — DB writes are simply skipped.
 */



/** Lazy, crash-safe Prisma client accessor */
async function getPrismaClient(): Promise<any | null> {
  try {
    // Dynamic import — if @prisma/client is missing or its native binary
    // can't load (e.g. on Vercel Lambda), we catch and return null.
    const { PrismaClient } = await import('@prisma/client')

    // Check if we're on Vercel with a SQLite file:// URL (won't work)
    const dbUrl = process.env.DATABASE_URL || ''
    if (dbUrl.startsWith('file:') && process.env.VERCEL === '1') {
      return null
    }

    const globalForPrisma = globalThis as unknown as { _betterbite_prisma?: any }

    if (!globalForPrisma._betterbite_prisma) {
      globalForPrisma._betterbite_prisma = new PrismaClient({ log: ['error'] })
    }

    return globalForPrisma._betterbite_prisma
  } catch (err) {
    console.warn('Prisma client unavailable (likely serverless environment):', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * A safe DB write helper that attempts a DB write and silently
 * swallows any error (including Prisma being entirely unavailable).
 */
export async function dbWrite(
  model: string,
  operation: string,
  data: unknown
): Promise<unknown> {
  try {
    const client = await getPrismaClient()
    if (!client) return null

    const modelObj = client[model]
    if (!modelObj) return null

    const fn = modelObj[operation]
    if (typeof fn !== 'function') return null

    return await fn(data)
  } catch (err) {
    console.warn(`DB write (${model}.${operation}) skipped:`, err instanceof Error ? err.message : err)
    return null
  }
}
