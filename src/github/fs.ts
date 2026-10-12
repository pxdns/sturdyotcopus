import {
  FileChangeType, FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, FileType,
  type IFileChange, type IFileDeleteOptions, type IFileOverwriteOptions, type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions, type IStat
} from '@codingame/monaco-vscode-files-service-override'
import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import type { Checkout } from './checkout'

export const GITHUB_SCHEME = 'github'

/** The workspace folder of a repository: github://owner/repo */
export const repoUri = (owner: string, repo: string): URI => URI.from({ scheme: GITHUB_SCHEME, authority: owner, path: `/${repo}` })

const err = (message: string, code: FileSystemProviderErrorCode): Error => FileSystemProviderError.create(message, code)

/** Exposes a Checkout (a GitHub repository with local edits) to the workbench as a file system. */
export class GitHubFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
  readonly onDidChangeCapabilities = Event.None
  private readonly emitter = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile = this.emitter.event

  constructor(private readonly checkout: Checkout) {
    checkout.onDidChange = (events) => {
      this.emitter.fire(events.map((e) => ({
        type: e.kind === 'created' ? FileChangeType.ADDED : e.kind === 'deleted' ? FileChangeType.DELETED : FileChangeType.UPDATED,
        resource: this.uri(e.path)
      })))
    }
  }

  private uri(path: string): URI {
    return repoUri(this.checkout.owner, this.checkout.repo).with({ path: `/${this.checkout.repo}${path ? '/' + path : ''}` })
  }

  /** Path inside the repository, without leading slash. */
  private rel(resource: URI): string {
    if (resource.authority !== this.checkout.owner) throw err('Unknown repository', FileSystemProviderErrorCode.FileNotFound)
    const prefix = `/${this.checkout.repo}`
    if (resource.path !== prefix && !resource.path.startsWith(prefix + '/')) throw err('Unknown repository', FileSystemProviderErrorCode.FileNotFound)
    return resource.path.slice(prefix.length).replace(/^\/+/, '')
  }

  watch(): { dispose(): void } {
    return { dispose() {} }
  }

  async stat(resource: URI): Promise<IStat> {
    const s = this.checkout.stat(this.rel(resource))
    if (!s) throw err('File not found', FileSystemProviderErrorCode.FileNotFound)
    return { type: s.kind === 'dir' ? FileType.Directory : FileType.File, ctime: 0, mtime: Date.now(), size: s.size }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    const path = this.rel(resource)
    const list = this.checkout.readdir(path)
    if (!list) throw err(this.checkout.stat(path) ? 'Not a directory' : 'Directory not found', this.checkout.stat(path) ? FileSystemProviderErrorCode.FileNotADirectory : FileSystemProviderErrorCode.FileNotFound)
    return list.map(([name, kind]) => [name, kind === 'dir' ? FileType.Directory : FileType.File])
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const path = this.rel(resource)
    const s = this.checkout.stat(path)
    if (!s) throw err('File not found', FileSystemProviderErrorCode.FileNotFound)
    if (s.kind === 'dir') throw err('Is a directory', FileSystemProviderErrorCode.FileIsADirectory)
    try {
      return await this.checkout.read(path)
    } catch (e) {
      throw err(`Could not read the file from GitHub: ${e instanceof Error ? e.message : String(e)}`, FileSystemProviderErrorCode.Unavailable)
    }
  }

  async writeFile(resource: URI, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    const path = this.rel(resource)
    if (!path) throw err('Cannot write the repository root', FileSystemProviderErrorCode.NoPermissions)
    const s = this.checkout.stat(path)
    if (s?.kind === 'dir') throw err('Is a directory', FileSystemProviderErrorCode.FileIsADirectory)
    if (!s && !opts.create) throw err('File not found', FileSystemProviderErrorCode.FileNotFound)
    if (s && opts.create && !opts.overwrite) throw err('File exists', FileSystemProviderErrorCode.FileExists)
    this.checkout.write(path, content)
  }

  async mkdir(resource: URI): Promise<void> {
    const path = this.rel(resource)
    if (this.checkout.stat(path)) throw err('Already exists', FileSystemProviderErrorCode.FileExists)
    this.checkout.mkdir(path)
  }

  async delete(resource: URI, _opts: IFileDeleteOptions): Promise<void> {
    const path = this.rel(resource)
    if (!path) throw err('Cannot delete the repository root', FileSystemProviderErrorCode.NoPermissions)
    if (!this.checkout.stat(path)) throw err('File not found', FileSystemProviderErrorCode.FileNotFound)
    this.checkout.remove(path)
  }

  async rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
    const a = this.rel(from)
    const b = this.rel(to)
    if (!this.checkout.stat(a)) throw err('File not found', FileSystemProviderErrorCode.FileNotFound)
    if (this.checkout.stat(b) && !opts.overwrite) throw err('Target exists', FileSystemProviderErrorCode.FileExists)
    await this.checkout.rename(a, b)
  }
}
