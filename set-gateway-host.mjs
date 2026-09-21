#!/usr/bin/env node
// ---------------------------------------------------------------------------
// set-gateway-host.mjs — point the whole RageStar project at one gateway host.
//
//   node set-gateway-host.mjs                      # -> gw.ragestar.bond
//   node set-gateway-host.mjs gw2.ragestar.bond    # -> any other subdomain
//   node set-gateway-host.mjs gw2.ragestar.bond api.ragestar.bond
//                                                  # ^new            ^old(s)
//
// Run from the repo root (the folder with package.json and cloudflare/ in it).
// Every edit is idempotent, so running it twice is a no-op. It touches:
//
//   .env / .env.example     VITE_GATEWAY_URL=https://<host>/v1  (adds if missing)
//   public/_headers         CSP connect-src gains https://<host>
//   vite.config.js          same, for the built-in CSP meta tag
//   cloudflare/wrangler.toml + any other tracked text file: old host -> new host
//
// Review with `git diff`, then `npm run build` — Vite inlines env vars at
// build time, so the .env change does nothing until you rebuild.
// ---------------------------------------------------------------------------

import {
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	existsSync,
} from "node:fs"
import { basename, extname, join, relative } from "node:path"

const ROOT = process.cwd()
const newHost = process.argv[2] || "gw.ragestar.bond"
const explicitOld = process.argv.slice(3)
const oldHosts = (
	explicitOld.length ? explicitOld : ["api.ragestar.bond", "gw.ragestar.bond"]
).filter((h) => h !== newHost)

if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/i.test(newHost)) {
	console.error(`Refusing to run: "${newHost}" does not look like a hostname.`)
	process.exit(1)
}
if (newHost.includes("://") || newHost.includes("/")) {
	console.error("Pass a bare hostname, not a URL (gw.ragestar.bond).")
	process.exit(1)
}

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".wrangler",
	".vercel",
	".next",
	"coverage",
	".turbo",
])
// DEPLOY-NEW-WORKER.md deliberately documents which hostname belongs to which
// Worker, so rewriting hostnames inside it would make the docs lie.
const SKIP_FILES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"DEPLOY-NEW-WORKER.md",
	basename(process.argv[1] || ""),
])
const TEXT_EXT = new Set([
	".js",
	".cjs",
	".mjs",
	".jsx",
	".ts",
	".tsx",
	".toml",
	".md",
	".json",
	".html",
	".txt",
	".yml",
	".yaml",
])
const TEXT_NAMES = new Set([
	"_headers",
	"_redirects",
	".env",
	".env.example",
	".env.local",
	".env.production",
])

function shouldRead(name) {
	if (SKIP_FILES.has(name)) return false
	if (TEXT_NAMES.has(name)) return true
	return TEXT_EXT.has(extname(name).toLowerCase())
}

function walk(dir, out = []) {
	let names
	try {
		names = readdirSync(dir)
	} catch {
		return out
	}
	for (const name of names) {
		if (SKIP_DIRS.has(name)) continue
		const full = join(dir, name)
		let st
		try {
			st = statSync(full)
		} catch {
			continue
		}
		if (st.isDirectory()) walk(full, out)
		else if (st.isFile() && st.size < 2000000 && shouldRead(name)) out.push(full)
	}
	return out
}

// CSP source lists are order-independent, so the host is inserted right after
// the directive name. That avoids having to work out where the directive ends,
// which is ambiguous inside a JS string full of quotes like 'self'.
function ensureConnectSrc(text) {
	const needle = `https://${newHost}`
	return text.replace(/connect-src(?=[\s;])/g, (match, offset) => {
		const rest = text.slice(offset, offset + 600)
		const stop = rest.search(/[;\n]/)
		const directive = stop === -1 ? rest : rest.slice(0, stop)
		if (directive.includes(needle)) return match
		return `connect-src ${needle}`
	})
}

function ensureGatewayUrl(text) {
	const line = `VITE_GATEWAY_URL=https://${newHost}/v1`
	if (/^[ \t]*VITE_GATEWAY_URL[ \t]*=.*$/m.test(text)) {
		return text.replace(/^[ \t]*VITE_GATEWAY_URL[ \t]*=.*$/m, line)
	}
	const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n"
	return `${text}${sep}${line}\n`
}

const changed = []
for (const file of walk(ROOT)) {
	const name = basename(file)
	let before
	try {
		before = readFileSync(file, "utf8")
	} catch {
		continue
	}
	let after = before
	for (const old of oldHosts) after = after.split(old).join(newHost)
	if (after.includes("connect-src")) after = ensureConnectSrc(after)
	if (name === ".env" || name === ".env.example") after = ensureGatewayUrl(after)
	if (after !== before) {
		writeFileSync(file, after)
		changed.push(relative(ROOT, file) || name)
	}
}

console.log(`Gateway host -> https://${newHost}/v1`)
if (oldHosts.length) console.log(`Rewriting: ${oldHosts.join(", ")}`)

if (changed.length === 0) {
	console.log("\nNothing to change — the project is already consistent.")
} else {
	console.log(`\n${changed.length} file(s) updated:`)
	for (const f of changed) console.log(`  ${f}`)
}

console.log("\nCheck these lines:")
for (const rel of [
	".env",
	".env.example",
	"public/_headers",
	"vite.config.js",
	"cloudflare/wrangler.toml",
]) {
	const full = join(ROOT, rel)
	if (!existsSync(full)) {
		console.log(`  ${rel}  (not found — skipped)`)
		continue
	}
	const hits = readFileSync(full, "utf8")
		.split(/\r?\n/)
		.filter(
			(l) =>
				l.includes("VITE_GATEWAY_URL") ||
				l.includes("connect-src") ||
				l.includes("pattern ="),
		)
	if (hits.length === 0) console.log(`  ${rel}  (no gateway reference found)`)
	else for (const h of hits) console.log(`  ${rel}: ${h.trim().slice(0, 170)}`)
}

console.log(
	"\nNext:  git diff   ->   npm run build   (Vite inlines env vars at build time)",
)
