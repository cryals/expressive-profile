import type { AuthoredLanguage, AuthoredRepository, AuthoredStats } from "../render";

const API = "https://api.github.com";
const MAX_REPOSITORIES = 100;
const MAX_COMMITS = 5000;
const EXCLUDED = /(^|\/)(node_modules|vendor|dist|build|coverage|\.next|\.nuget)(\/|$)|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|cargo\.lock|go\.sum)$/i;
const MINIFIED = /\.min\.(?:js|css)$/i;

const EXTENSIONS: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", kts: "Kotlin", cs: "C#", fs: "F#",
  cpp: "C++", cc: "C++", cxx: "C++", c: "C", h: "C", hpp: "C++", rb: "Ruby", php: "PHP",
  swift: "Swift", scala: "Scala", dart: "Dart", lua: "Lua", r: "R", rkt: "Racket", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", hrl: "Erlang", hs: "Haskell", clj: "Clojure", cljs: "Clojure", groovy: "Groovy",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell", sql: "SQL", html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", vue: "Vue", svelte: "Svelte", md: "Markdown",
  yml: "YAML", yaml: "YAML", json: "JSON", toml: "TOML", xml: "XML", dockerfile: "Dockerfile",
};

export class GitHubAnalysisError extends Error {
  constructor(message: "auth" | "mismatch" | "rate-limit" | "failed", readonly reset?: Date) {
    super(message);
  }
}

type ApiFetch = (path: string) => Promise<Response>;
type ApiRepository = { full_name: string; name: string; html_url: string; disabled?: boolean };
type ApiCommit = { sha: string; author?: { login?: string | null } | null; commit?: { author?: { email?: string | null } | null } | null };

export interface AnalysisProgress { repository: string; completed: number; total: number; commits: number; }
export interface AnalysisOptions {
  login: string;
  token?: string;
  maxRepositories?: number;
  maxCommits?: number;
  onProgress?: (progress: AnalysisProgress) => void;
  request?: ApiFetch;
}

function headers(token?: string) {
  return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function nextLink(link: string | null) {
  if (!link) return null;
  const item = link.split(",").find((value) => /rel="next"/.test(value));
  return item ? /<([^>]+)>/.exec(item)?.[1] ?? null : null;
}

function toPath(url: string) {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

async function page<T>(request: ApiFetch, path: string, result: T[] = []): Promise<T[]> {
  const response = await request(path);
  if (!response.ok) throw response;
  result.push(...(await response.json() as T[]));
  const next = nextLink(response.headers.get("link"));
  return next ? page<T>(request, toPath(next), result) : result;
}

function language(path: string) {
  if (EXCLUDED.test(path) || MINIFIED.test(path)) return null;
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "Dockerfile";
  const extension = name.includes(".") ? name.split(".").pop()! : "";
  return EXTENSIONS[extension] ?? "Other";
}

function authored(commit: ApiCommit, login: string, emails: Set<string>) {
  if (commit.author?.login?.toLowerCase() === login.toLowerCase()) return true;
  const email = commit.commit?.author?.email?.toLowerCase();
  return !!email && emails.has(email);
}

function partial(reason: AuthoredStats["partial"] extends infer T ? T extends { reason: infer R } ? R : never : never, scanned: number, total: number) {
  return { reason, scanned, total } as AuthoredStats["partial"];
}

async function verifiedEmails(request: ApiFetch) {
  try {
    const response = await request("/user/emails");
    if (!response.ok) return new Set<string>();
    const values = await response.json() as { email?: string; verified?: boolean }[];
    return new Set(values.filter((item) => item.verified && item.email).map((item) => item.email!.toLowerCase()));
  } catch {
    return new Set<string>();
  }
}

export async function analyzeAuthoredStats(options: AnalysisOptions): Promise<AuthoredStats> {
  const login = options.login.trim();
  const token = options.token?.trim() || undefined;
  const request: ApiFetch = options.request ?? ((path) => fetch(`${API}${path}`, { headers: headers(token) }));
  const maxRepositories = options.maxRepositories ?? MAX_REPOSITORIES;
  const maxCommits = options.maxCommits ?? MAX_COMMITS;
  const scope: AuthoredStats["scope"] = token ? "authenticated" : "public";

  const checked = async (path: string) => {
    const response = await request(path);
    if (response.status === 401) throw new GitHubAnalysisError("auth");
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      throw new GitHubAnalysisError("rate-limit", reset ? new Date(reset * 1000) : undefined);
    }
    if (!response.ok) throw new GitHubAnalysisError("failed");
    return response;
  };

  let authorLogin = login;
  let emails = new Set<string>();
  if (token) {
    const viewer = await (await checked("/user")).json() as { login?: string; email?: string | null };
    if (!viewer.login || viewer.login.toLowerCase() !== login.toLowerCase()) throw new GitHubAnalysisError("mismatch");
    authorLogin = viewer.login;
    emails = await verifiedEmails(request);
    if (viewer.email) emails.add(viewer.email.toLowerCase());
  }

  let repositories: ApiRepository[];
  try {
    repositories = token
      ? await page<ApiRepository>(request, "/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&per_page=100&sort=updated")
      : await page<ApiRepository>(request, `/users/${encodeURIComponent(login)}/repos?type=owner&per_page=100&sort=updated`);
  } catch (error) {
    if (error instanceof GitHubAnalysisError) throw error;
    const response = error as Response;
    if (response.status === 403 || response.status === 429) throw new GitHubAnalysisError("rate-limit");
    throw new GitHubAnalysisError("failed");
  }

  const stats: AuthoredStats = { scope, repositoriesScanned: 0, repositoriesWithCommits: 0, commits: 0, additions: 0, deletions: 0, languages: [], repositories: [] };
  const languages = new Map<string, AuthoredLanguage>();
  const total = Math.min(repositories.length, maxRepositories);
  if (repositories.length > maxRepositories) stats.partial = partial("repository-limit", 0, repositories.length);
  const seen = new Set<string>();

  for (const repository of repositories.slice(0, maxRepositories)) {
    if (repository.disabled) continue;
    if (seen.size >= maxCommits) {
      stats.partial = partial("commit-limit", stats.repositoriesScanned, total);
      break;
    }
    try {
      const branches = await page<{ name: string }>(request, `/repos/${repository.full_name}/branches?per_page=100`);
      const commits = new Map<string, ApiCommit>();
      for (const branch of branches) {
        const list = await page<ApiCommit>(request, `/repos/${repository.full_name}/commits?sha=${encodeURIComponent(branch.name)}&per_page=100`);
        for (const commit of list) if (authored(commit, authorLogin, emails)) commits.set(commit.sha, commit);
      }
      let repoCommits = 0;
      let additions = 0;
      let deletions = 0;
      for (const commit of commits.values()) {
        if (seen.has(commit.sha)) continue;
        if (seen.size >= maxCommits) {
          stats.partial = partial("commit-limit", stats.repositoriesScanned, total);
          break;
        }
        seen.add(commit.sha);
        const detail = await checked(`/repos/${repository.full_name}/commits/${commit.sha}`);
        const body = await detail.json() as { files?: { filename?: string; additions?: number; deletions?: number }[] };
        repoCommits++;
        stats.commits++;
        for (const file of body.files ?? []) {
          const kind = language(file.filename ?? "");
          if (!kind) continue;
          const plus = file.additions ?? 0;
          const minus = file.deletions ?? 0;
          additions += plus;
          deletions += minus;
          const current = languages.get(kind) ?? { name: kind, additions: 0, deletions: 0, changed: 0 };
          current.additions += plus;
          current.deletions += minus;
          current.changed += plus + minus;
          languages.set(kind, current);
        }
      }
      if (repoCommits) {
        stats.repositoriesWithCommits++;
        stats.additions += additions;
        stats.deletions += deletions;
        stats.repositories.push({ name: repository.name, url: repository.html_url, commits: repoCommits, additions, deletions });
      }
      stats.repositoriesScanned++;
      options.onProgress?.({ repository: repository.name, completed: stats.repositoriesScanned, total, commits: stats.commits });
    } catch (error) {
      if (error instanceof GitHubAnalysisError && error.message === "rate-limit") {
        stats.partial = partial("rate-limit", stats.repositoriesScanned, total);
        break;
      }
      stats.partial ??= partial("inaccessible", stats.repositoriesScanned, total);
    }
  }
  stats.languages = [...languages.values()].sort((a, b) => b.changed - a.changed);
  stats.repositories.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return stats;
}
