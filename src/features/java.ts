import type * as vscode from 'vscode'
import { parse } from 'java-parser'
import type { CstNode, IToken } from 'java-parser'

type Vscode = typeof vscode

interface Sym { name: string; kind: 'class' | 'interface' | 'enum' | 'method' | 'constructor' | 'field'; detail: string; start: [number, number]; end: [number, number]; children: Sym[] }

const isNode = (e: CstNode | IToken): e is CstNode => 'children' in e

function firstToken(n: CstNode | IToken | undefined): IToken | undefined {
  if (!n) return undefined
  if (!isNode(n)) return n
  let best: IToken | undefined
  for (const list of Object.values(n.children)) for (const c of list) {
    const t = firstToken(c as CstNode | IToken)
    if (t && (!best || t.startOffset < best.startOffset)) best = t
  }
  return best
}
const child = (n: CstNode, name: string): CstNode | undefined => n.children[name]?.[0] as CstNode | undefined

/** Declarations (types, methods, fields) from a parsed compilation unit. */
function symbols(root: CstNode): Sym[] {
  const out: Sym[] = []
  const stack: Sym[][] = [out]
  const make = (n: CstNode, name: string | undefined, kind: Sym['kind'], detail = ''): Sym | undefined => {
    if (!name) return undefined
    const s: Sym = { name, kind, detail, start: [n.location.startLine - 1, n.location.startColumn - 1], end: [(n.location.endLine ?? n.location.startLine) - 1, (n.location.endColumn ?? n.location.startColumn)], children: [] }
    stack[stack.length - 1].push(s)
    return s
  }
  const visit = (n: CstNode): void => {
    let pushed: Sym | undefined
    switch (n.name) {
      case 'normalClassDeclaration': pushed = make(n, firstToken(child(n, 'typeIdentifier'))?.image, 'class'); break
      case 'enumDeclaration': pushed = make(n, firstToken(child(n, 'typeIdentifier'))?.image, 'enum'); break
      case 'normalInterfaceDeclaration': pushed = make(n, firstToken(child(n, 'typeIdentifier'))?.image, 'interface'); break
      case 'recordDeclaration': pushed = make(n, firstToken(child(n, 'typeIdentifier'))?.image, 'class', 'record'); break
      case 'methodDeclaration':
      case 'interfaceMethodDeclaration': {
        const decl = find(n, 'methodDeclarator')
        // this parser version reads `record P(int a) {}` as a method whose return type is the word "record"
        const isRecord = n.name === 'methodDeclaration' && firstToken(find(n, 'methodHeader'))?.image === 'record'
        make(n, firstToken(decl)?.image, isRecord ? 'class' : 'method', isRecord ? 'record' : '')
        break
      }
      case 'constructorDeclaration': {
        const decl = find(n, 'constructorDeclarator')
        make(n, firstToken(find(decl, 'typeIdentifier'))?.image, 'constructor')
        break
      }
      case 'fieldDeclaration': {
        const list = child(n, 'variableDeclaratorList')
        for (const d of (list?.children.variableDeclarator ?? []) as CstNode[]) make(d, firstToken(child(d, 'variableDeclaratorId'))?.image, 'field')
        break
      }
    }
    if (pushed) stack.push(pushed.children)
    for (const list of Object.values(n.children)) for (const c of list) if (isNode(c as CstNode | IToken)) visit(c as CstNode)
    if (pushed) stack.pop()
  }
  visit(root)
  return out
}
function find(n: CstNode | undefined, name: string): CstNode | undefined {
  if (!n) return undefined
  if (n.name === name) return n
  for (const list of Object.values(n.children)) for (const c of list) {
    if (!isNode(c as CstNode | IToken)) continue
    const r = find(c as CstNode, name)
    if (r) return r
  }
  return undefined
}

const KEYWORDS = ['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'new', 'package', 'private', 'protected', 'public', 'record', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'try', 'var', 'void', 'volatile', 'while']
const TYPES = ['String', 'Object', 'Integer', 'Long', 'Double', 'Boolean', 'Character', 'Math', 'System', 'StringBuilder', 'List', 'ArrayList', 'Map', 'HashMap', 'Set', 'HashSet', 'Optional', 'Arrays', 'Collections', 'Objects', 'Stream', 'Collectors', 'Runnable', 'Thread', 'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'Override', 'FunctionalInterface']

const SNIPPETS: [string, string, string][] = [
  ['main', 'public static void main(String[] args)', 'public static void main(String[] args) {\n\t$0\n}'],
  ['sout', 'System.out.println(...)', 'System.out.println($0);'],
  ['serr', 'System.err.println(...)', 'System.err.println($0);'],
  ['fori', 'for (int i = 0; i < n; i++)', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}'],
  ['foreach', 'for (T x : items)', 'for (${1:var} ${2:item} : ${3:items}) {\n\t$0\n}'],
  ['trycatch', 'try { } catch (Exception e) { }', 'try {\n\t$1\n} catch (${2:Exception} ${3:e}) {\n\t$0\n}'],
  ['psvm', 'public static void main', 'public static void main(String[] args) {\n\t$0\n}'],
  ['class', 'public class', 'public class ${1:${TM_FILENAME_BASE}} {\n\t$0\n}'],
  ['interface', 'public interface', 'public interface ${1:${TM_FILENAME_BASE}} {\n\t$0\n}'],
  ['record', 'public record', 'public record ${1:${TM_FILENAME_BASE}}(${2:int id}) {\n}']
]

export function activateJava(vs: Vscode): void {
  const diagnostics = vs.languages.createDiagnosticCollection('java')
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const cache = new Map<string, { version: number; syms: Sym[] }>()

  const check = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== 'java') return
    const text = doc.getText()
    try {
      const cst = parse(text) as CstNode
      diagnostics.set(doc.uri, [])
      cache.set(doc.uri.toString(), { version: doc.version, syms: symbols(cst) })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const m = /line: (\d+), column: (\d+)/.exec(msg)
      const line = m ? Number(m[1]) - 1 : 0
      const col = m ? Number(m[2]) - 1 : 0
      const lineLen = doc.lineAt(Math.min(line, doc.lineCount - 1)).text.length
      const range = new vs.Range(line, Math.max(0, Math.min(col, lineLen)), line, Math.max(col + 1, lineLen))
      const expecting = /Expecting: (?:one of these possible Token sequences:)?([\s\S]*?)but found: '([^']*)'/.exec(msg)
      const message = expecting ? `Syntax error: unexpected '${expecting[2]}'` : 'Syntax error'
      diagnostics.set(doc.uri, [new vs.Diagnostic(range, message, vs.DiagnosticSeverity.Error)])
      cache.delete(doc.uri.toString())
    }
  }
  const schedule = (doc: vscode.TextDocument): void => {
    if (doc.languageId !== 'java') return
    const key = doc.uri.toString()
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => check(doc), 400))
  }
  vs.workspace.onDidOpenTextDocument(check)
  vs.workspace.onDidChangeTextDocument((e) => schedule(e.document))
  vs.workspace.onDidCloseTextDocument((d) => { diagnostics.delete(d.uri); cache.delete(d.uri.toString()) })
  vs.workspace.textDocuments.forEach(check)

  const KIND: Record<Sym['kind'], vscode.SymbolKind> = {
    class: vs.SymbolKind.Class, interface: vs.SymbolKind.Interface, enum: vs.SymbolKind.Enum,
    method: vs.SymbolKind.Method, constructor: vs.SymbolKind.Constructor, field: vs.SymbolKind.Field
  }
  const toSymbol = (s: Sym): vscode.DocumentSymbol => {
    const range = new vs.Range(s.start[0], s.start[1], s.end[0], s.end[1])
    const sym = new vs.DocumentSymbol(s.name, s.detail, KIND[s.kind], range, range)
    sym.children = s.children.map(toSymbol)
    return sym
  }
  vs.languages.registerDocumentSymbolProvider({ language: 'java' }, {
    provideDocumentSymbols(doc) {
      let c = cache.get(doc.uri.toString())
      if (!c || c.version !== doc.version) { check(doc); c = cache.get(doc.uri.toString()) }
      return (c?.syms ?? []).map(toSymbol)
    }
  })

  vs.languages.registerCompletionItemProvider({ language: 'java' }, {
    provideCompletionItems(doc, pos) {
      const line = doc.lineAt(pos.line).text.slice(0, pos.character)
      if (/\.\s*\w*$/.test(line)) return [] // member access: no type information in the browser
      const items: vscode.CompletionItem[] = []
      for (const [label, detail, body] of SNIPPETS) {
        const it = new vs.CompletionItem(label, vs.CompletionItemKind.Snippet)
        it.detail = detail
        it.insertText = new vs.SnippetString(body)
        items.push(it)
      }
      for (const k of KEYWORDS) items.push(new vs.CompletionItem(k, vs.CompletionItemKind.Keyword))
      for (const t of TYPES) items.push(new vs.CompletionItem(t, vs.CompletionItemKind.Class))
      const seen = new Set<string>()
      const add = (list: Sym[]): void => { for (const s of list) { if (!seen.has(s.name)) { seen.add(s.name); const it = new vs.CompletionItem(s.name, s.kind === 'method' ? vs.CompletionItemKind.Method : s.kind === 'field' ? vs.CompletionItemKind.Field : vs.CompletionItemKind.Class); it.detail = 'in this file'; items.push(it) } add(s.children) } }
      add(cache.get(doc.uri.toString())?.syms ?? [])
      return items
    }
  })
}
