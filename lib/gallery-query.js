// Implements the subset of the VS Code Marketplace "gallery" protocol that the workbench uses, on top of
// the self-hosted catalog produced by scripts/build-catalog.mjs (public/gallery/catalog.json).
// Pure functions only, so the same code serves Vercel (api/gallery.js) and the Vite dev/preview server.

const FilterType = { Tag: 1, ExtensionId: 4, Category: 5, ExtensionName: 7, Target: 8, Featured: 9, SearchText: 10, ExcludeWithFlags: 12 }
const SortBy = { Relevance: 0, LastUpdated: 1, Title: 2, Publisher: 3, InstallCount: 4, AverageRating: 6, PublishedDate: 10, WeightedRating: 12 }
const WEB_EXTENSION_TAG = '__web_extension'

const ASSET_TYPES = {
  manifest: 'Microsoft.VisualStudio.Code.Manifest',
  details: 'Microsoft.VisualStudio.Services.Content.Details',
  changelog: 'Microsoft.VisualStudio.Services.Content.Changelog',
  license: 'Microsoft.VisualStudio.Services.Content.License',
  icon: 'Microsoft.VisualStudio.Services.Icons.Default'
}

const lower = (s) => String(s ?? '').toLowerCase()

/** Converts a catalog entry to the raw gallery extension shape the workbench expects. */
export function toRawExtension(entry, origin) {
  const assetUri = `${origin}/gallery/assets/${entry.publisher}/${entry.name}/${entry.version}`
  const date = entry.timestamp ? new Date(entry.timestamp).toISOString() : '2020-01-01T00:00:00.000Z'
  const files = Object.entries(ASSET_TYPES)
    .filter(([key]) => entry.assets?.[key])
    .map(([key, assetType]) => ({ assetType, source: `${assetUri}/${assetType}` }))
  const properties = [
    { key: 'Microsoft.VisualStudio.Code.Engine', value: entry.engine || '*' },
    { key: 'Microsoft.VisualStudio.Code.ExecutesCode', value: entry.executesCode ? 'true' : 'false' }
  ]
  if (entry.dependencies?.length) properties.push({ key: 'Microsoft.VisualStudio.Code.ExtensionDependencies', value: entry.dependencies.join(',') })
  if (entry.extensionPack?.length) properties.push({ key: 'Microsoft.VisualStudio.Code.ExtensionPack', value: entry.extensionPack.join(',') })
  if (entry.repository && /\.git$/.test(entry.repository)) properties.push({ key: 'Microsoft.VisualStudio.Services.Links.Source', value: entry.repository })
  return {
    extensionId: entry.uuid,
    extensionName: entry.name,
    displayName: entry.displayName,
    shortDescription: entry.description,
    publisher: { publisherId: entry.uuid, publisherName: entry.publisher, displayName: entry.publisher, flags: 'verified' },
    versions: [{ version: entry.version, lastUpdated: date, assetUri, fallbackAssetUri: assetUri, files, properties, flags: 'validated' }],
    categories: entry.categories ?? [],
    tags: [...new Set([...(entry.tags ?? []), WEB_EXTENSION_TAG])],
    releaseDate: date,
    publishedDate: date,
    lastUpdated: date,
    statistics: [
      { statisticName: 'install', value: entry.downloadCount ?? 0 },
      { statisticName: 'averagerating', value: entry.averageRating ?? 0 },
      { statisticName: 'ratingcount', value: entry.ratingCount ?? 0 }
    ],
    flags: entry.preview ? 'validated, preview' : 'validated'
  }
}

function score(entry, tokens) {
  const id = lower(entry.id)
  const title = lower(entry.displayName)
  const desc = lower(entry.description)
  const tags = lower([...(entry.tags ?? []), ...(entry.categories ?? [])].join(' '))
  let total = 0
  for (const t of tokens) {
    let s = 0
    if (title === t || id === t) s = 100
    else if (title.startsWith(t) || id.startsWith(t) || lower(entry.name).startsWith(t)) s = 60
    else if (title.includes(t) || id.includes(t)) s = 40
    else if (tags.includes(t)) s = 15
    else if (desc.includes(t)) s = 8
    if (s === 0) return 0 // every token must match something
    total += s
  }
  return total
}

/** Runs a gallery query ({ filters:[{criteria,pageNumber,pageSize,sortBy,sortOrder}] }) over the catalog. */
export function queryGallery(catalog, body, origin) {
  const filter = body?.filters?.[0] ?? {}
  const criteria = Array.isArray(filter.criteria) ? filter.criteria : []
  const pageSize = Math.min(Math.max(Number(filter.pageSize) || 10, 1), 200)
  const pageNumber = Math.max(Number(filter.pageNumber) || 1, 1)
  const sortBy = Number(filter.sortBy) || SortBy.Relevance
  const ascending = Number(filter.sortOrder) === 1

  let list = catalog
  const text = []
  for (const c of criteria) {
    const value = String(c.value ?? '')
    switch (Number(c.filterType)) {
      case FilterType.ExtensionId: {
        const ids = new Set(criteria.filter((x) => Number(x.filterType) === FilterType.ExtensionId).map((x) => lower(x.value)))
        list = list.filter((e) => ids.has(lower(e.uuid)))
        break
      }
      case FilterType.ExtensionName: {
        const names = new Set(criteria.filter((x) => Number(x.filterType) === FilterType.ExtensionName).map((x) => lower(x.value)))
        list = list.filter((e) => names.has(lower(e.id)))
        break
      }
      case FilterType.Category:
        list = list.filter((e) => e.categories?.some((cat) => lower(cat) === lower(value)))
        break
      case FilterType.Tag:
        if (value !== WEB_EXTENSION_TAG) list = list.filter((e) => e.tags?.some((t) => lower(t) === lower(value)))
        break
      case FilterType.SearchText:
        text.push(...lower(value).split(/\s+/).filter(Boolean))
        break
      default:
        break // Target / Featured / ExcludeWithFlags: every catalog entry qualifies
    }
  }

  let scores
  if (text.length) {
    scores = new Map()
    list = list.filter((e) => {
      const s = score(e, text)
      scores.set(e, s)
      return s > 0
    })
  }

  const num = (v) => Number(v) || 0
  const cmp = {
    [SortBy.LastUpdated]: (a, b) => num(Date.parse(b.timestamp)) - num(Date.parse(a.timestamp)),
    [SortBy.PublishedDate]: (a, b) => num(Date.parse(b.timestamp)) - num(Date.parse(a.timestamp)),
    [SortBy.Title]: (a, b) => lower(a.displayName).localeCompare(lower(b.displayName)),
    [SortBy.Publisher]: (a, b) => lower(a.publisher).localeCompare(lower(b.publisher)),
    [SortBy.InstallCount]: (a, b) => num(b.downloadCount) - num(a.downloadCount),
    [SortBy.AverageRating]: (a, b) => num(b.averageRating) - num(a.averageRating),
    [SortBy.WeightedRating]: (a, b) => num(b.averageRating) * Math.log(2 + num(b.ratingCount)) - num(a.averageRating) * Math.log(2 + num(a.ratingCount))
  }[sortBy]
  const sorted = [...list]
  if (cmp) {
    sorted.sort(cmp)
    // Title/Publisher are naturally ascending; every other sort is descending unless asked otherwise.
    const naturallyAscending = sortBy === SortBy.Title || sortBy === SortBy.Publisher
    if (naturallyAscending ? Number(filter.sortOrder) === 2 : ascending) sorted.reverse()
  } else {
    // relevance: text score, then popularity
    sorted.sort((a, b) => (scores ? (scores.get(b) ?? 0) - (scores.get(a) ?? 0) : 0) || num(b.downloadCount) - num(a.downloadCount))
  }

  const page = sorted.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
  return {
    results: [
      {
        extensions: page.map((e) => toRawExtension(e, origin)),
        pagingToken: null,
        resultMetadata: [{ metadataType: 'ResultCount', metadataItems: [{ name: 'TotalCount', count: sorted.length }] }]
      }
    ]
  }
}

/**
 * Routes a request below /api/gallery.
 * @returns {{status:number, body?:any}} JSON response description
 */
export function handleGalleryRequest({ method, path, body, catalog, origin }) {
  const p = '/' + String(path ?? '').replace(/^\/+|\/+$/g, '')
  if (p === '/extensionquery' && method === 'POST') return { status: 200, body: queryGallery(catalog, body, origin) }
  const latest = /^\/vscode\/([^/]+)\/([^/]+)\/latest$/.exec(p)
  if (latest && method === 'GET') {
    const id = lower(`${latest[1]}.${latest[2]}`)
    const entry = catalog.find((e) => lower(e.id) === id)
    return entry ? { status: 200, body: toRawExtension(entry, origin) } : { status: 404, body: { error: 'Extension not found' } }
  }
  if (p === '/' || p === '/health') return { status: 200, body: { ok: true, extensions: catalog.length } }
  return { status: 404, body: { error: 'Not found' } }
}
