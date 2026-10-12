import type * as vscode from 'vscode'
import type { Checkout } from '../github/checkout'
import { activateAi } from './ai'
import { activateGithub } from './github'
import { activateGradle } from './gradle'
import { activateUploads } from './uploads'
import { activateJava } from './java'
import { activatePython } from './python'
import { activateRunner } from './runner'

export interface LumaContext {
  checkout?: Checkout
  problems: string[]
}

/** Starts the built-in features once the workbench is initialised. */
export function activateLuma(vs: typeof vscode, ctx: LumaContext): void {
  activatePython(vs)
  activateJava(vs)
  activateUploads(vs)
  activateAi(vs)
  activateGradle(vs)
  activateGithub(vs, ctx.checkout, ctx.problems)
  activateRunner(vs, () => (ctx.checkout ? { repo: `${ctx.checkout.owner}/${ctx.checkout.repo}`, ref: ctx.checkout.ref } : {}))
}
