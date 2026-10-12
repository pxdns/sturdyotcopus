// IndexedDB persistence for GitHub working copies: the file tree of the base commit, the user's unsynced changes (overlay),
// and downloaded file contents. Reloading the page therefore never loses edits and never refetches what we already have.
import type { TreeEntry } from './api'

export interface CheckoutRecord {
  key: string // owner/repo@ref
  owner: string
  repo: string
  ref: string
  baseOid: string
  tree: TreeEntry[]
  /** path -> new content, or null for a deletion */
  overlay: [string, Uint8Array | null][]
  dirs: string[]
  syncedAt: number
}

const DB = 'luma-github'
let dbPromise: Promise<IDBDatabase> | undefined

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('checkouts')
      req.result.createObjectStore('blobs')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(store: 'checkouts' | 'blobs', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const loadCheckout = (key: string): Promise<CheckoutRecord | undefined> => tx('checkouts', 'readonly', (s) => s.get(key) as IDBRequest<CheckoutRecord | undefined>)
export const saveCheckout = (r: CheckoutRecord): Promise<IDBValidKey> => tx('checkouts', 'readwrite', (s) => s.put(r, r.key))
export const loadBlob = (key: string): Promise<Uint8Array | undefined> => tx('blobs', 'readonly', (s) => s.get(key) as IDBRequest<Uint8Array | undefined>)
export const saveBlob = (key: string, bytes: Uint8Array): Promise<IDBValidKey> => tx('blobs', 'readwrite', (s) => s.put(bytes, key))
