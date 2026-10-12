import type * as vscode from 'vscode'

type Vscode = typeof vscode

const isGradle = (d: vscode.TextDocument): boolean => /(^|\/)(build|settings)\.gradle(\.kts)?$/.test(d.uri.path)

const COMMON_TASKS = ['build', 'clean', 'test', 'assemble', 'check', 'run', 'jar', 'bootRun', 'dependencies', 'tasks', 'projects']

const SNIPPETS: [string, string, string][] = [
  ['plugins', 'plugins { }', "plugins {\n\tid '${1:java}'\n}"],
  ['repositories', 'repositories { mavenCentral() }', 'repositories {\n\tmavenCentral()\n}'],
  ['dependencies', 'dependencies { }', "dependencies {\n\timplementation '${1:group:artifact:version}'\n\ttestImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'\n}"],
  ['implementation', 'implementation dependency', "implementation '${1:group:artifact:version}'"],
  ['testImplementation', 'testImplementation dependency', "testImplementation '${1:group:artifact:version}'"],
  ['java toolchain', 'java { toolchain }', 'java {\n\ttoolchain {\n\t\tlanguageVersion = JavaLanguageVersion.of(${1:21})\n\t}\n}'],
  ['application', 'application { mainClass }', "application {\n\tmainClass = '${1:com.example.Main}'\n}"],
  ['test', 'tasks.test { useJUnitPlatform() }', 'tasks.named(\'test\') {\n\tuseJUnitPlatform()\n}'],
  ['task', 'register a task', "tasks.register('${1:name}') {\n\tdoLast {\n\t\t$0\n\t}\n}"],
  ['include', 'settings: include a subproject', "include '${1:subproject}'"]
]

/** Reads a Gradle script: plugins, declared dependencies, tasks. Pattern based; it does not run Gradle. */
function outline(text: string): { name: string; detail: string; line: number; kind: 'plugin' | 'dep' | 'task' | 'block' | 'include' }[] {
  const out: ReturnType<typeof outline> = []
  text.split(/\r?\n/).forEach((raw, line) => {
    const l = raw.trim()
    let m: RegExpExecArray | null
    if ((m = /^id\s*\(?\s*['"]([^'"]+)['"]/.exec(l))) out.push({ name: m[1], detail: 'plugin', line, kind: 'plugin' })
    else if ((m = /^(api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|classpath)\s*\(?\s*['"]([^'"]+)['"]/.exec(l))) out.push({ name: m[2], detail: m[1], line, kind: 'dep' })
    else if ((m = /^tasks\.(?:register|create)\s*\(\s*['"]([^'"]+)['"]/.exec(l)) || (m = /^task\s+\(?['"]?(\w+)/.exec(l))) out.push({ name: m[1], detail: 'task', line, kind: 'task' })
    else if ((m = /^include\s*\(?\s*['"]([^'"]+)['"]/.exec(l))) out.push({ name: m[1], detail: 'subproject', line, kind: 'include' })
    else if ((m = /^(plugins|repositories|dependencies|java|application|buildscript|subprojects|allprojects)\s*\{/.exec(l))) out.push({ name: m[1], detail: 'block', line, kind: 'block' })
  })
  return out
}

export function activateGradle(vs: Vscode): void {
  const diagnostics = vs.languages.createDiagnosticCollection('gradle')

  const inspect = (doc: vscode.TextDocument): void => {
    if (!isGradle(doc)) return
    const items: vscode.Diagnostic[] = []
    const text = doc.getText()
    let depth = 0
    for (const ch of text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""')) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth !== 0) items.push(new vs.Diagnostic(new vs.Range(0, 0, 0, 1), `Unbalanced braces (${depth > 0 ? depth + ' unclosed' : -depth + ' extra closing'}).`, vs.DiagnosticSeverity.Error))
    text.split(/\r?\n/).forEach((raw, line) => {
      if (/jcenter\s*\(\s*\)/.test(raw)) items.push(new vs.Diagnostic(new vs.Range(line, 0, line, raw.length), 'jcenter() is deprecated and read-only. Use mavenCentral().', vs.DiagnosticSeverity.Warning))
      if (/^\s*compile\s+['"(]/.test(raw)) items.push(new vs.Diagnostic(new vs.Range(line, 0, line, raw.length), "The 'compile' configuration was removed in Gradle 7. Use 'implementation' or 'api'.", vs.DiagnosticSeverity.Warning))
    })
    diagnostics.set(doc.uri, items)
  }
  vs.workspace.onDidOpenTextDocument(inspect)
  vs.workspace.onDidChangeTextDocument((e) => inspect(e.document))
  vs.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri))
  vs.workspace.textDocuments.forEach(inspect)

  const selector: vscode.DocumentSelector = [{ pattern: '**/*.gradle' }, { pattern: '**/*.gradle.kts' }]
  const KIND = { plugin: vs.SymbolKind.Package, dep: vs.SymbolKind.Package, task: vs.SymbolKind.Function, block: vs.SymbolKind.Namespace, include: vs.SymbolKind.Module }
  vs.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(doc) {
      return outline(doc.getText()).map((o) => {
        const r = doc.lineAt(o.line).range
        return new vs.DocumentSymbol(o.name, o.detail, KIND[o.kind], r, r)
      })
    }
  })
  vs.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems() {
      return SNIPPETS.map(([label, detail, body]) => {
        const it = new vs.CompletionItem(label, vs.CompletionItemKind.Snippet)
        it.detail = detail
        it.insertText = new vs.SnippetString(body)
        return it
      })
    }
  })

  /** Runs `./gradlew <task>` in the remote runner (a browser tab cannot run a JVM). */
  vs.commands.registerCommand('luma.gradle.runTask', async (preset?: string) => {
    const task = preset ?? (await vs.window.showQuickPick(COMMON_TASKS, { placeHolder: 'Gradle task to run in the remote runner', title: 'Gradle: Run Task' }))
    if (!task) return
    await vs.commands.executeCommand('workbench.action.terminal.newWithProfile', { profileName: 'Remote runner' })
    setTimeout(() => void vs.commands.executeCommand('workbench.action.terminal.sendSequence', { text: `if [ -x ./gradlew ]; then ./gradlew ${task}; else gradle ${task}; fi\r` }), 2500)
  })
  vs.commands.registerCommand('luma.gradle.showProjects', async () => {
    const files = await vs.workspace.findFiles('**/{build,settings}.gradle{,.kts}', '**/node_modules/**', 50)
    if (!files.length) { void vs.window.showInformationMessage('No Gradle build files found in this workspace.'); return }
    const pick = await vs.window.showQuickPick(files.map((f) => ({ label: vs.workspace.asRelativePath(f), uri: f })), { title: 'Gradle build files' })
    if (pick) await vs.commands.executeCommand('vscode.open', pick.uri)
  })
}
