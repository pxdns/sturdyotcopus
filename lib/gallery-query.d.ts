export interface CatalogEntry {
  id: string
  uuid: string
  publisher: string
  name: string
  version: string
  displayName: string
  description: string
  categories: string[]
  tags: string[]
  downloadCount: number
  averageRating: number
  ratingCount: number
  timestamp: string | number | null
  license: string
  repository: string
  engine: string
  preview: boolean
  dependencies: string[]
  extensionPack: string[]
  executesCode: boolean
  assets: Partial<Record<'manifest' | 'details' | 'changelog' | 'license' | 'icon', string>>
}
export function toRawExtension(entry: CatalogEntry, origin: string): unknown
export function queryGallery(catalog: CatalogEntry[], body: unknown, origin: string): unknown
export function handleGalleryRequest(req: {
  method: string
  path: string
  body?: unknown
  catalog: CatalogEntry[]
  origin: string
}): { status: number; body?: unknown }
