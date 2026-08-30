import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getActiveModel, getProvider } from '@/lib/settings'
import {
  seedDefaultCategories,
  categorizeBatch,
  mapBookmarkForCategorization,
  writeCategoryResults,
  BOOKMARK_SELECT,
} from '@/lib/categorizer'
import {
  analyzeItem,
  runWithConcurrency,
  enrichBatchSemanticTags,
  ENRICH_BATCH_SIZE,
  BookmarkForEnrichment,
} from '@/lib/vision-analyzer'
import { backfillEntities } from '@/lib/rawjson-extractor'
import { rebuildFts } from '@/lib/fts'

type Stage = 'vision' | 'entities' | 'enrichment' | 'categorize' | 'parallel'

interface CategorizationState {
  status: 'idle' | 'running' | 'stopping'
  stage: Stage | null
  done: number
  total: number
  stageCounts: {
    visionTagged: number
    entitiesExtracted: number
    enriched: number
    categorized: number
  }
  failed: number
  lastError: string | null
  error: string | null
}

// In-memory state for progress tracking across requests
const globalState = globalThis as unknown as {
  categorizationState: CategorizationState
  categorizationAbort: boolean
}

if (!globalState.categorizationState) {
  globalState.categorizationState = {
    status: 'idle',
    stage: null,
    done: 0,
    total: 0,
    stageCounts: { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 },
    failed: 0,
    lastError: null,
    error: null,
  }
}
if (globalState.categorizationAbort === undefined) {
  globalState.categorizationAbort = false
}

function shouldAbort(): boolean {
  return globalState.categorizationAbort
}

function getState(): CategorizationState {
  return { ...globalState.categorizationState }
}

function setState(update: Partial<CategorizationState>): void {
  globalState.categorizationState = { ...globalState.categorizationState, ...update }
}

export async function GET(): Promise<NextResponse> {
  const state = getState()
  return NextResponse.json({
    status: state.status,
    stage: state.stage,
    done: state.done,
    total: state.total,
    stageCounts: state.stageCounts,
    failed: state.failed,
    lastError: state.lastError,
    error: state.error,
  })
}

export async function DELETE(): Promise<NextResponse> {
  const state = getState()
  if (state.status !== 'running') {
    return NextResponse.json({ error: 'No pipeline running' }, { status: 409 })
  }
  globalState.categorizationAbort = true
  setState({ status: 'stopping' })
  return NextResponse.json({ stopped: true })
}

const PIPELINE_WORKERS = 5
const CAT_BATCH_SIZE = 25
// If this many categorization batches fail back-to-back without a single success,
// the AI provider is misconfigured — abort instead of marking every bookmark "done"
// while tagging nothing.
const MAX_CONSECUTIVE_CAT_FAILURES = 3

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (getState().status === 'running' || getState().status === 'stopping') {
    return NextResponse.json({ error: 'Categorization is already running' }, { status: 409 })
  }

  let body: { bookmarkIds?: string[]; apiKey?: string; force?: boolean } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { bookmarkIds = [], apiKey, force = false } = body

  if (apiKey && typeof apiKey === 'string' && apiKey.trim() !== '') {
    const currentProvider = await getProvider()
    const keySlot = currentProvider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
    await prisma.setting.upsert({
      where: { key: keySlot },
      update: { value: apiKey.trim() },
      create: { key: keySlot, value: apiKey.trim() },
    })
  }

  globalState.categorizationAbort = false

  let total = 0
  try {
    if (bookmarkIds.length > 0) {
      total = bookmarkIds.length
    } else if (force) {
      total = await prisma.bookmark.count()
    } else {
      total = await prisma.bookmark.count({ where: { enrichedAt: null } })
    }
  } catch {
    total = 0
  }

  setState({
    status: 'running',
    stage: 'entities',
    done: 0,
    total,
    stageCounts: { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 },
    failed: 0,
    lastError: null,
    error: null,
  })

  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const dbApiKey =
    (await prisma.setting.findUnique({ where: { key: keyName } }))?.value?.trim() || ''

  void (async () => {
    const counts = { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 }
    let failedCount = 0
    let firstError: string | null = null
    let firstCategorizeError: string | null = null
    let autoAborted = false

    // Per-item API failures used to be logged and dropped, so a run with a dead
    // API key reported "done" for every bookmark with all stage counts at zero.
    // Record them on the state object so the failure is visible to callers.
    function recordFailure(stage: string, err: unknown, count = 1): void {
      failedCount += count
      // Generous cap: provider errors are verbose and the most diagnostic part
      // (e.g. the CLI-attempt reason) is appended last.
      const message = `[${stage}] ${err instanceof Error ? err.message : String(err)}`.slice(0, 800)
      if (firstError === null) firstError = message
      if (stage === 'categorize' && firstCategorizeError === null) firstCategorizeError = message
      setState({ failed: failedCount, lastError: firstError })
    }

    try {
      let client: AIClient | null = null
      try {
        client = await resolveAIClient({ dbKey: dbApiKey })
      } catch {
        // SDK client not available — CLI path may still work (e.g. ChatGPT OAuth via codex exec)
        console.warn('No SDK client available — will rely on CLI path')
      }

        await seedDefaultCategories()

        if (force) {
          await prisma.mediaItem.updateMany({ where: { imageTags: '{}' }, data: { imageTags: null } })
          await prisma.bookmark.updateMany({ where: { semanticTags: '[]' }, data: { semanticTags: null } })
        }

        // Stage 1: Entity extraction (free, fast — no API calls)
        if (!shouldAbort()) {
          setState({ stage: 'entities' })
          counts.entitiesExtracted = await backfillEntities((n) => {
            counts.entitiesExtracted = n
            setState({ stageCounts: { ...counts } })
          }, shouldAbort).catch((err) => {
            console.error('Entity extraction error:', err)
            return counts.entitiesExtracted
          })
          setState({ stageCounts: { ...counts } })
        }

        // Stage 2: Parallel pipeline — vision + enrichment + categorize per bookmark
        if (!shouldAbort()) {
          // Fetch all bookmark IDs to process
          let bookmarkIdsToProcess: string[]
          if (bookmarkIds.length > 0) {
            bookmarkIdsToProcess = bookmarkIds
          } else if (force) {
            const all = await prisma.bookmark.findMany({ select: { id: true }, orderBy: { id: 'asc' } })
            bookmarkIdsToProcess = all.map((b) => b.id)
          } else {
            const unprocessed = await prisma.bookmark.findMany({
              where: { enrichedAt: null },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
            bookmarkIdsToProcess = unprocessed.map((b) => b.id)
          }

          const runTotal = bookmarkIdsToProcess.length
          setState({ stage: 'parallel', done: 0, total: runTotal, stageCounts: { ...counts } })

          // Load category metadata once (shared across all workers)
          const dbCategories = await prisma.category.findMany({
            select: { slug: true, name: true, description: true },
          })
          const allSlugs = dbCategories.map((c) => c.slug)
          const categoryDescriptions = Object.fromEntries(
            dbCategories.map((c) => [c.slug, c.description?.trim() || c.name]),
          )
          const model = await getActiveModel()

          // Shared categorization queue (JS single-threaded: splice is atomic vs async)
          const catPending: string[] = []
          let catFlushing = false
          let consecutiveCatFailures = 0

          async function drainCategorizeQueue(final = false): Promise<void> {
            if (final) {
              // Wait for any in-progress flush before draining remainder
              while (catFlushing) {
                await new Promise<void>((resolve) => setTimeout(resolve, 50))
              }
            } else if (catFlushing || catPending.length < CAT_BATCH_SIZE) {
              return
            }

            catFlushing = true
            try {
              while (catPending.length > 0) {
                if (autoAborted) break
                if (!final && catPending.length < CAT_BATCH_SIZE) break
                const ids = catPending.splice(0, CAT_BATCH_SIZE)
                if (ids.length === 0) break
                const rows = await prisma.bookmark.findMany({
                  where: { id: { in: ids } },
                  select: BOOKMARK_SELECT,
                })
                const batch = rows.map(mapBookmarkForCategorization)
                try {
                  const results = await categorizeBatch(batch, client, categoryDescriptions, allSlugs)
                  await writeCategoryResults(results)
                  counts.categorized += ids.length
                  consecutiveCatFailures = 0
                  setState({ stageCounts: { ...counts } })
                } catch (catErr) {
                  console.error('[parallel] categorize batch error:', catErr)
                  recordFailure('categorize', catErr, ids.length)
                  consecutiveCatFailures++
                  if (
                    counts.categorized === 0 &&
                    consecutiveCatFailures >= MAX_CONSECUTIVE_CAT_FAILURES
                  ) {
                    autoAborted = true
                    globalState.categorizationAbort = true
                    setState({ status: 'stopping' })
                    break
                  }
                }
              }
            } finally {
              catFlushing = false
            }
          }

          let processedCount = 0

          // Process in chunks: vision (concurrent) -> enrichment (batched) ->
          // categorization. Enrichment used to run one API call per bookmark;
          // batching it cuts the call count by ENRICH_BATCH_SIZE. Enrichment must
          // be persisted before a bookmark is queued for categorization, because
          // the categorization prompt reads semanticTags.
          const CHUNK_SIZE = ENRICH_BATCH_SIZE * PIPELINE_WORKERS

          async function processChunk(chunkIds: string[]): Promise<void> {
            const rows = await prisma.bookmark.findMany({
              where: { id: { in: chunkIds } },
              select: {
                id: true,
                text: true,
                semanticTags: true,
                entities: true,
                mediaItems: {
                  where: { type: { in: ['photo', 'gif', 'video'] } },
                  select: { id: true, url: true, thumbnailUrl: true, type: true, imageTags: true },
                },
              },
            })
            if (rows.length === 0) return

            // Stage A: vision — analyse every untagged media item in the chunk
            const visionTasks: (() => Promise<void>)[] = []
            for (const bm of rows) {
              for (const media of bm.mediaItems) {
                if (media.imageTags !== null) continue
                visionTasks.push(async () => {
                  if (shouldAbort()) return
                  try {
                    // analyzeItem returns 0 when analysis produced no tags; counting
                    // that as "tagged" used to inflate visionTagged on a failing provider.
                    const tagged = await analyzeItem(
                      { id: media.id, url: media.url, thumbnailUrl: media.thumbnailUrl, type: media.type },
                      client,
                      model,
                    )
                    if (tagged > 0) {
                      counts.visionTagged++
                      setState({ stageCounts: { ...counts } })
                    } else {
                      recordFailure('vision', new Error(`no tags produced for media ${media.id}`))
                    }
                  } catch (err) {
                    console.warn('[parallel] vision failed for', media.id, err instanceof Error ? err.message : err)
                    recordFailure('vision', err)
                  }
                })
              }
            }
            const anyVisionRan = visionTasks.length > 0
            if (anyVisionRan) await runWithConcurrency(visionTasks, PIPELINE_WORKERS)
            if (shouldAbort()) return

            // Stage B: collect image tags for the chunk (one query, post-vision)
            const imageTagsByBookmark = new Map<string, string[]>()
            const keepTag = (t: string | null): t is string => t !== null && t !== '' && t !== '{}'
            if (anyVisionRan) {
              const media = await prisma.mediaItem.findMany({
                where: { bookmarkId: { in: chunkIds }, type: { in: ['photo', 'gif', 'video'] } },
                select: { bookmarkId: true, imageTags: true },
              })
              for (const m of media) {
                if (!keepTag(m.imageTags)) continue
                const list = imageTagsByBookmark.get(m.bookmarkId) ?? []
                list.push(m.imageTags)
                imageTagsByBookmark.set(m.bookmarkId, list)
              }
            } else {
              for (const bm of rows) {
                const list = bm.mediaItems.map((m) => m.imageTags).filter(keepTag)
                if (list.length > 0) imageTagsByBookmark.set(bm.id, list)
              }
            }

            // Stage C: enrichment — one API call per ENRICH_BATCH_SIZE bookmarks
            const trivialIds: string[] = []
            const toEnrich: BookmarkForEnrichment[] = []
            for (const bm of rows) {
              if (bm.semanticTags) continue
              const imageTags = imageTagsByBookmark.get(bm.id) ?? []
              if (imageTags.length === 0 && bm.text.length < 20) {
                trivialIds.push(bm.id)
                continue
              }
              let entities: BookmarkForEnrichment['entities'] = undefined
              if (bm.entities) {
                try {
                  entities = JSON.parse(bm.entities) as BookmarkForEnrichment['entities']
                } catch { /* ignore */ }
              }
              toEnrich.push({ id: bm.id, text: bm.text, imageTags, entities })
            }

            if (trivialIds.length > 0) {
              await prisma.bookmark.updateMany({
                where: { id: { in: trivialIds } },
                data: { semanticTags: '[]' },
              })
            }

            const enrichBatches: BookmarkForEnrichment[][] = []
            for (let i = 0; i < toEnrich.length; i += ENRICH_BATCH_SIZE) {
              enrichBatches.push(toEnrich.slice(i, i + ENRICH_BATCH_SIZE))
            }

            // PIPELINE_WORKERS bookmarks previously ran concurrently, each free to
            // make its own enrichment call, so this keeps the same concurrency
            // envelope while making far fewer calls.
            await runWithConcurrency(
              enrichBatches.map((batch) => async () => {
                if (shouldAbort()) return
                try {
                  const results = await enrichBatchSemanticTags(batch, client)
                  const byId = new Map(results.map((r) => [r.id, r]))
                  for (const item of batch) {
                    const result = byId.get(item.id)
                    if (!result?.tags.length) continue
                    await prisma.bookmark.update({
                      where: { id: item.id },
                      data: {
                        semanticTags: JSON.stringify(result.tags),
                        enrichmentMeta: JSON.stringify({
                          sentiment: result.sentiment,
                          people: result.people,
                          companies: result.companies,
                        }),
                      },
                    })
                    counts.enriched++
                  }
                  setState({ stageCounts: { ...counts } })
                } catch (err) {
                  console.warn('[parallel] enrichment failed for batch:', err instanceof Error ? err.message : err)
                  recordFailure('enrichment', err, batch.length)
                }
              }),
              PIPELINE_WORKERS,
            )
            if (shouldAbort()) return

            // Stage D: hand the chunk to the categorization queue
            for (const bm of rows) catPending.push(bm.id)
            processedCount += rows.length
            setState({ done: processedCount, stageCounts: { ...counts } })
            await drainCategorizeQueue()
          }

          try {
            for (let start = 0; start < bookmarkIdsToProcess.length; start += CHUNK_SIZE) {
              if (shouldAbort()) break
              await processChunk(bookmarkIdsToProcess.slice(start, start + CHUNK_SIZE))
            }
          } finally {
            // Always drain remaining items even if a chunk threw
            await drainCategorizeQueue(true)
          }
        }
    } catch (err) {
      console.error('Pipeline error:', err)
      setState({ lastError: err instanceof Error ? err.message.slice(0, 200) : String(err) })
    }

    if (!shouldAbort()) {
      await rebuildFts().catch((err) => console.error('FTS rebuild error:', err))
    }

    return {
      failed: failedCount,
      firstError,
      firstCategorizeError,
      autoAborted,
      categorized: counts.categorized,
    }
  })()
    .then((summary) => {
      const wasStopped = globalState.categorizationAbort
      globalState.categorizationAbort = false
      const finalState = getState()

      let error: string | null = null
      if (summary.autoAborted) {
        error =
          `Aborted after ${MAX_CONSECUTIVE_CAT_FAILURES} consecutive categorization failures ` +
          `with nothing categorized. First categorization error: ` +
          `${summary.firstCategorizeError ?? summary.firstError ?? 'unknown'}`
      } else if (wasStopped) {
        error = 'Stopped by user'
      } else if (summary.failed > 0) {
        error =
          `Completed with ${summary.failed} failed item(s). ` +
          `First error: ${summary.firstError ?? 'unknown'}`
      }

      setState({
        status: 'idle',
        stage: null,
        // Report what was actually processed. Forcing done = total here used to make a
        // run that categorized nothing look like a clean, complete pass.
        done: finalState.done,
        total: finalState.total,
        failed: summary.failed,
        lastError: summary.firstError,
        error,
      })
    })
    .catch((err) => {
      globalState.categorizationAbort = false
      console.error('Categorization pipeline error:', err)
      setState({
        status: 'idle',
        stage: null,
        error: err instanceof Error ? err.message : String(err),
      })
    })

  return NextResponse.json({ status: 'started', total })
}
