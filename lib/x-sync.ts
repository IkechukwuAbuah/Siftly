import prisma from '@/lib/db'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'

// ── Sync ────────────────────────────────────────────────────────────────────────

export async function syncBookmarks(
  authToken: string,
  ct0: string,
): Promise<{ imported: number; skipped: number }> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  try {
    let imported = 0
    let skipped = 0
    let cursor: string | undefined
    const MAX_PAGES = 50

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchPage(authToken, ct0, cursor)
      const { tweets, nextCursor } = parsePage(data)

      // On the first page, verify the API response structure hasn't changed
      if (page === 0 && tweets.length === 0 && !nextCursor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
        if (!hasTimeline) {
          throw new Error('Twitter API response format has changed. The sync feature may need updating.')
        }
      }

      const result = await importTweets(tweets)
      imported += result.imported
      skipped += result.skipped

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor

      if (page === MAX_PAGES - 1) {
        console.warn(`[x-sync] Hit max page limit (${MAX_PAGES}), stopping pagination`)
      }
    }

    // Only update last sync timestamp if we actually fetched tweets
    if (imported > 0 || skipped > 0) {
      const now = new Date().toISOString()
      await prisma.setting.upsert({
        where: { key: 'x_last_sync' },
        update: { value: now },
        create: { key: 'x_last_sync', value: now },
      })
    }

    return { imported, skipped }
  } finally {
    syncing = false
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

type SyncInterval = '1h' | '4h' | '8h' | '24h' | '48h'

const INTERVAL_MS: Record<SyncInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '48h': 48 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let syncing = false

export async function startScheduler() {
  stopScheduler()

  const intervalSetting = await prisma.setting.findUnique({ where: { key: 'x_sync_interval' } })
  if (!intervalSetting?.value || intervalSetting.value === 'off') return

  const interval = intervalSetting.value as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalSetting.value}" in database, not starting scheduler`)
    return
  }

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[x-sync] Scheduler stopped')
  }
}

async function runScheduledSync() {
  if (syncing) return

  try {
    const [authSetting, ct0Setting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
      prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
    ])

    if (!authSetting?.value || !ct0Setting?.value) {
      console.log('[x-sync] Skipping scheduled sync: missing credentials')
      return
    }

    console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)
    const result = await syncBookmarks(authSetting.value, ct0Setting.value)
    console.log(`[x-sync] Sync complete: ${result.imported} imported, ${result.skipped} skipped`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[x-sync] Scheduled sync failed:', message)
    if (message.includes('401') || message.includes('403')) {
      console.error('[x-sync] Auth error detected, stopping scheduler')
      stopScheduler()
    }
  }
}

export function isSchedulerRunning() {
  return schedulerTimer !== null
}

export function isSyncing() {
  return syncing
}
