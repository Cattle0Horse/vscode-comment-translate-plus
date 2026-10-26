import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { parse } from "yaml"

const root = fileURLToPath(new URL("./", import.meta.url))
const offline = process.argv.includes("--offline")
const repositories = {
  cspell: "streetsidesoftware/cspell-dicts",
  devicon: "devicons/devicon",
  linguist: "github-linguist/linguist"
}
const sources = []
const ordinaryWords = new Set(["tools", "ADMIN", "BTN", "REF", "go", "rust", "swift", "make", "less", "expect", "Feature", "Settings", "string", "Token", "token"])
await mkdir(resolve(root, "snapshots"), { recursive: true })
await mkdir(resolve(root, "candidates"), { recursive: true })
await mkdir(resolve(root, "licenses"), { recursive: true })

async function json(path, value) {
  await writeFile(resolve(root, path), JSON.stringify(value, null, 2) + "\n")
}

async function load(id, source, path, destination = `snapshots/${id}.txt`) {
  const url = `https://raw.githubusercontent.com/${repositories[source]}/HEAD/${path}`
  const local = resolve(root, destination)
  let body
  if (offline) body = await readFile(local)
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
    body = Buffer.from(await response.arrayBuffer())
    await writeFile(local, body)
  }
  sources.push({ id, source, path, url, snapshot: destination, bytes: body.length })
  return body.toString("utf8")
}

const categories = {}
const origins = new Map()
const rejected = []
const sort = (values) => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

// Preserve the first spelling (manual additions, then canonical names, then sources).
function uniqueRules(values) {
  const rules = new Map()
  for (const term of values) {
    const key = JSON.stringify(typeof term === "string" ? term.toLowerCase() : term)
    if (!rules.has(key)) rules.set(key, term)
  }
  return [...rules.values()]
}

function add(category, term, source) {
  if (typeof term !== "string" || !term.trim() || /[\r\n]/u.test(term) || term.includes("\0")) throw Error(`Invalid entry in ${source}`)
  if (!categories[category]) categories[category] = []
  categories[category].push(term)
  const list = origins.get(term) ?? new Set()
  list.add(source)
  origins.set(term, list)
}

for (const name of ["computing-acronyms", "network-protocols", "software-tools", "software-services", "software-terms"]) {
  const id = `cspell-${name}`
  const text = await load(id, "cspell", `dictionaries/software-terms/src/${name}.txt`)
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const term = line.replace(/\s+#.*$/u, "").trim()
    if (!term || term.startsWith("#")) continue
    // Do not mistake CSpell syntax/affixes for literal preserved names.
    if (/^[!+~*]|[+*]$|\s/u.test(term) && !/^[\p{L}\p{N} ._/#():&'’+-]+$/u.test(term)) {
      rejected.push({ source: id, line: index + 1, value: term, reason: "需要检查词典语法，不自动解释为保留词" })
      continue
    }
    add(id, term, id)
  }
}
const icons = JSON.parse(await load("devicon", "devicon", "devicon.json", "snapshots/devicon.json"))
if (!Array.isArray(icons)) throw Error("Devicon must be an array")
for (const icon of icons) {
  add("devicon-names", icon.name, "devicon")
  for (const alias of icon.altnames ?? []) add("devicon-names", alias, "devicon")
}
const languages = parse(await load("linguist", "linguist", "lib/linguist/languages.yml", "snapshots/linguist.yml"))
if (!languages || typeof languages !== "object" || Array.isArray(languages)) throw Error("Linguist must be a mapping")
for (const [name, data] of Object.entries(languages)) {
  add("linguist-languages", name, "linguist")
  for (const alias of data.aliases ?? []) add("linguist-languages", alias, "linguist")
  for (const filename of data.filenames ?? []) add("linguist-filenames", filename, "linguist")
}
await load("cspell-license", "cspell", "dictionaries/software-terms/LICENSE", "licenses/cspell-MIT.txt")
await load("devicon-license", "devicon", "LICENSE", "licenses/devicon-MIT.txt")
await load("linguist-license", "linguist", "LICENSE", "licenses/linguist-MIT.txt")

const all = sort(origins.keys())
const allowlist =
  `API AWS Android Ansible Apache ArgoCD Avro Azure Babel Bazel Bitbucket CMake CPU CSS CDN CentOS CircleCI ClickHouse Cloudflare CockroachDB CouchDB Couchbase DBAL DDR DNS DOS DRAM DRM DTLS Debian Deno DigitalOcean Django Docker Elasticsearch Erlang ESLint Fedora Firefox FreeBSD GCP GCC GDB GEMM GNOME GNU GPKG GPU GRPC GUI GUID Git GitHub GitLab Gitleaks GoLand GraphQL HTML HTTP HTTPS HashiCorp IntelliJ Java JavaScript JetBrains Jira JSON JSONLD JWKS JWT Kafka KafkaJS Kibana Knative Kubernetes LLVM Linux LTS LXC MariaDB Microsoft MongoDB MySQL NDJSON NGINX NPM NUMA NetBSD Netlify Neovim NixOS Node.js NuGet Nushell ODBC OIDC OpenAPI OpenBSD OpenCL OpenCV OpenGL OpenJDK OpenMP OpenSSH OpenSSL OpenStack OpenTofu OpenVPN Oxc PHP PLSQL PostgreSQL PowerShell Prometheus Protobuf PyCharm Pylance Pyright Python Qt RAM RDP RHEL RPC RPKI RTSP RabbitMQ Redis Ruby SQL SRAM SSD SSH SSID SQLite Scala SpringBoot Svelte TCP TSQL Terraform TypeScript UHF UI UUID UTF-8 Ubuntu VCPU VFIO VNC VPN VPS VRAM VSCode VXLAN Vim Vitess Vue WebAssembly WebGL Webpack WHATWG WLAN WWW WYSIWYG Wayland X11 XFS XML XSD YAML Zabbix ZeroMQ Zig Zsh Zypper bzip cspell curl dotenv etcd esbuild grpc gzip httpie jq jsdelivr kubectl libcurl macOS minikube mitmproxy npm npx oxlint oxfmt pip pnpm podman pytest ripgrep rustfmt systemctl systemd tmux unpkg uv.lock vcpkg vsce vscode wget yamllint yarn zoxide`.split(
    /\s+/u
  )
const selected = []
const selectedProvenance = []
const absent = []
for (const canonical of sort(uniqueRules(allowlist))) {
  const spellings = all.filter((term) => term.toLowerCase() === canonical.toLowerCase())
  if (!spellings.length) {
    absent.push(canonical)
    continue
  }
  selected.push(canonical)
  selectedProvenance.push({ term: canonical, sourceSpellings: spellings, sources: sort(spellings.flatMap((word) => [...origins.get(word)])) })
}
const counts = {}
for (const [category, terms] of Object.entries(categories)) {
  const unique = sort(terms)
  counts[category] = unique.length
  await json(`candidates/${category}.json`, unique)
}
await json("candidates/all.json", all)
await json("candidates/selected.json", sort(selected))
const additions = JSON.parse(await readFile(resolve(root, "additions.json"), "utf8"))
if (!Array.isArray(additions)) throw Error("additions.json must be an array")
const full = uniqueRules([...additions, ...sort(selected), ...all])
const excluded = new Set([...ordinaryWords].map((term) => term.toLowerCase()))
const curated = uniqueRules([...additions, ...sort(selected)].filter((term) => typeof term !== "string" || !excluded.has(term.toLowerCase())))
await json("../resources/preserve-terms.json", curated)
await json("../resources/preserve-terms.full.json", full)
await json("provenance.json", { candidates: all.map((term) => ({ term, sources: sort(origins.get(term)) })), selected: selectedProvenance })
await json("review.json", {
  status: "候选全集未经逐项语义审核；selected 是人工挑选的起始子集，尚未接入或进行真实翻译验收",
  ambiguousExamples: [...ordinaryWords].map((term) => ({
    term,
    found: all.includes(term),
    selected: curated.includes(term)
  })),
  allowlistNotFound: absent,
  rejected
})
const manifest = {
  collectedOn: "2026-10-23",
  format: "preserveTerms 使用的 JSON 数组，支持字符串字面值与显式正则对象",
  normalization:
    "输出词库的字符串按 toLowerCase() 忽略大小写去重，依次保留人工补充、规范名称、上游的首个拼写；候选与溯源保留原始拼写；正则原样保留；不取 Devicon tags/图标变体或 Linguist 文件扩展名",
  repositories,
  outputs: { curated: "resources/preserve-terms.json", full: "resources/preserve-terms.full.json" },
  counts: { ...counts, allUnique: all.length, selected: sort(selected).length, curated: curated.length, full: full.length, rejected: rejected.length },
  licenses: { cspell: "MIT", devicon: "MIT", linguist: "MIT" },
  sources
}
await json("manifest.json", manifest)
console.log(JSON.stringify(manifest.counts, null, 2))
