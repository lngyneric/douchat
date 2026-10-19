// Builds the web app and copies it into douchat-tanstack/public/app, where the
// service serves it at /app and as app.douchat.ai.
//   node scripts/publish-web.mjs [--target ../douchat-tanstack/public/app]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const at = args.indexOf('--target')
const target = resolve(at >= 0 ? args[at + 1] : '../douchat-tanstack/public/app')
if (!existsSync(resolve(target, '..'))) throw new Error(`${resolve(target, '..')} does not exist`)

execFileSync('npx', ['vite', 'build', '--config', 'vite.web.config.ts'], { stdio: 'inherit' })
rmSync(target, { recursive: true, force: true })
cpSync(resolve('out/web'), target, { recursive: true })
console.log(`published web app to ${target}`)
