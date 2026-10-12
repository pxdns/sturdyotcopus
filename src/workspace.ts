import {
  IndexedDB,
  IndexedDBFileSystemProvider,
  initFile,
  registerCustomProvider
} from '@codingame/monaco-vscode-files-service-override'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'

export const WORKSPACE_ROOT = URI.file('/workspace')

const SEEDED_KEY = 'webvscode.workspace.seeded.v1'
const STORE = 'workspace-files'

const sample: Record<string, string> = {
  'README.md': `# Welcome to Web VS Code

This is an in-browser workspace. Files are saved to **IndexedDB**, so they survive reloads.

- Open the command palette with \`F1\` or \`Ctrl/Cmd+Shift+P\`
- Pick a theme with **Preferences: Color Theme** (try *Glass Dark* / *Glass Light*)
- Browse extensions from Open VSX in the Extensions view
`,
  'src/Program.cs': `using System;
using System.Collections.Generic;

namespace Sample
{
    /// <summary>Represents a greeter.</summary>
    public interface IGreeter
    {
        string Greet(string name);
    }

    public enum Mood { Happy, Sad }

    public class Greeter : IGreeter
    {
        private readonly string _prefix = "Hello";
        public Mood Mood { get; set; } = Mood.Happy;

        public string Greet(string name)
        {
            // build the message
            if (string.IsNullOrEmpty(name)) throw new ArgumentException("name\\n");
            return $"{_prefix}, {name}! {42}";
        }
    }

    internal static class Program
    {
#if DEBUG
        private const int Retries = 3;
#endif
        private static void Main(string[] args)
        {
            var greeter = new Greeter();
            foreach (var arg in args) Console.WriteLine(greeter.Greet(arg));
        }
    }
}
`,
  'src/index.ts': `interface User {
  id: number
  name: string
}

const users: User[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Linus' }
]

export function greet(user: User): string {
  return \`Hello, \${user.name}!\`
}

for (const user of users) {
  console.log(greet(user), /ab+c/.test(user.name), 0xff)
}
`,
  'src/main.js': `// Plain JavaScript
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2)
}

console.log('fib(10) =', fib(10))
`,
  'public/index.html': `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Sample</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1 id="title" class="big">Hello, glass!</h1>
    <script src="../src/main.js"></script>
  </body>
</html>
`,
  'public/style.css': `:root {
  --accent: #007acc;
}

.big,
#title {
  color: var(--accent);
  font-size: 2rem;
  margin: 0 auto;
}

@media (max-width: 600px) {
  h1:hover { opacity: 0.8 }
}
`,
  'package.json': `{
  "name": "sample-workspace",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node src/main.js" }
}
`
}

/** Registers a persistent (IndexedDB-backed) `file:` provider and seeds a sample workspace once. */
export async function setupWorkspace(): Promise<void> {
  const db = await IndexedDB.create('web-vscode-workspace', 1, [STORE])
  const provider = new IndexedDBFileSystemProvider('file', db, STORE, false)
  registerCustomProvider('file', provider)

  let seeded = false
  try {
    seeded = localStorage.getItem(SEEDED_KEY) === '1'
  } catch {
    /* storage unavailable: treat as not seeded, initFile never overwrites */
  }
  if (seeded) return

  const dirs = new Set<string>(['/workspace'])
  for (const rel of Object.keys(sample)) {
    const parts = rel.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) dirs.add('/workspace/' + parts.slice(0, i).join('/'))
  }
  for (const dir of [...dirs].sort()) {
    try {
      await provider.mkdir(URI.file(dir))
    } catch {
      /* already exists */
    }
  }
  for (const [rel, content] of Object.entries(sample)) {
    await initFile(URI.file('/workspace/' + rel), content)
  }
  try {
    localStorage.setItem(SEEDED_KEY, '1')
  } catch {
    /* ignore */
  }
}
