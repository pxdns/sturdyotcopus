// Minimal GitHub REST + GraphQL client for the workspace feature. All calls use the signed-in user's token.
import { getSession, githubFetch } from './auth'

export interface RepoInfo {
  fullName: string
  owner: string
  name: string
  defaultBranch: string
  private: boolean
}

export interface TreeEntry {
  path: string
  sha: string
  size: number
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { message?: string }).message ?? '' } catch { /* not json */ }
    throw new GitHubError(`GitHub ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
  }
  return (await res.json()) as T
}

export const graphqlUrl = (): string => {
  const api = getSession()?.apiUrl ?? 'https://api.github.com'
  return api.endsWith('/api/v3') ? api.replace(/\/api\/v3$/, '/api/graphql') : `${api}/graphql`
}

export async function listRepos(): Promise<RepoInfo[]> {
  const pages = await Promise.all([1, 2, 3].map(async (page) => {
    const res = await githubFetch(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`)
    return json<{ full_name: string; name: string; owner: { login: string }; default_branch: string; private: boolean }[]>(res)
  }))
  return pages.flat().map((r) => ({ fullName: r.full_name, owner: r.owner.login, name: r.name, defaultBranch: r.default_branch, private: r.private }))
}

export async function getRepo(owner: string, repo: string): Promise<RepoInfo> {
  const r = await json<{ full_name: string; name: string; owner: { login: string }; default_branch: string; private: boolean }>(await githubFetch(`/repos/${owner}/${repo}`))
  return { fullName: r.full_name, owner: r.owner.login, name: r.name, defaultBranch: r.default_branch, private: r.private }
}

export async function listBranches(owner: string, repo: string): Promise<string[]> {
  const res = await json<{ name: string }[]>(await githubFetch(`/repos/${owner}/${repo}/branches?per_page=100`))
  return res.map((b) => b.name)
}

/** The commit a branch currently points to. */
export async function getHead(owner: string, repo: string, ref: string): Promise<string> {
  const r = await json<{ commit: { sha: string } }>(await githubFetch(`/repos/${owner}/${repo}/branches/${encodeURIComponent(ref)}`))
  return r.commit.sha
}

export async function getTree(owner: string, repo: string, commit: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const c = await json<{ tree: { sha: string } }>(await githubFetch(`/repos/${owner}/${repo}/git/commits/${commit}`))
  const t = await json<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean }>(await githubFetch(`/repos/${owner}/${repo}/git/trees/${c.tree.sha}?recursive=1`))
  return { entries: t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 })), truncated: t.truncated }
}

export async function getBlob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
  const res = await githubFetch(`/repos/${owner}/${repo}/git/blobs/${sha}`, { headers: { Accept: 'application/vnd.github.raw+json' } })
  if (!res.ok) throw new GitHubError(`GitHub ${res.status} reading a file`, res.status)
  return new Uint8Array(await res.arrayBuffer())
}

/** Paths changed between two commits, or undefined when GitHub cannot list them all (treat as a conflict). */
export async function changedPaths(owner: string, repo: string, base: string, head: string): Promise<Set<string> | undefined> {
  const r = await json<{ files?: { filename: string; previous_filename?: string }[]; total_commits?: number }>(await githubFetch(`/repos/${owner}/${repo}/compare/${base}...${head}?per_page=100`))
  const files = r.files ?? []
  if (files.length >= 100) return undefined
  const out = new Set<string>()
  for (const f of files) { out.add(f.filename); if (f.previous_filename) out.add(f.previous_filename) }
  return out
}

export async function createBranch(owner: string, repo: string, name: string, sha: string): Promise<void> {
  await json(await githubFetch(`/repos/${owner}/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${name}`, sha }), headers: { 'Content-Type': 'application/json' } }))
}

export interface CommitInput {
  owner: string
  repo: string
  branch: string
  expectedHeadOid: string
  headline: string
  body: string
  additions: { path: string; contents: string }[] // base64
  deletions: { path: string }[]
}

export const COMMIT_MUTATION = 'mutation($input: CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid url}}}'

/** The request body for one atomic commit (also used by the page-hide flush). */
export function commitBody(c: CommitInput): string {
  return JSON.stringify({
    query: COMMIT_MUTATION,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: `${c.owner}/${c.repo}`, branchName: c.branch },
        message: { headline: c.headline, body: c.body },
        fileChanges: { additions: c.additions, deletions: c.deletions },
        expectedHeadOid: c.expectedHeadOid
      }
    }
  })
}

export async function createCommit(c: CommitInput): Promise<string> {
  const res = await githubFetch(graphqlUrl(), { method: 'POST', body: commitBody(c), headers: { 'Content-Type': 'application/json' } })
  const data = await json<{ data?: { createCommitOnBranch?: { commit: { oid: string } } }; errors?: { message: string }[] }>(res)
  const oid = data.data?.createCommitOnBranch?.commit.oid
  if (!oid) throw new GitHubError(data.errors?.map((e) => e.message).join('; ') || 'The commit was not created', 422)
  return oid
}

/** Git blob id of some bytes: sha1("blob <size>\0" + content). Lets us know file ids without asking GitHub. */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const all = new Uint8Array(header.length + bytes.length)
  all.set(header)
  all.set(bytes, header.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
