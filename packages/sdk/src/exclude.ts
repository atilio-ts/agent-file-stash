import { basename, dirname } from "node:path";

const DEFAULT_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".npmrc",
  ".netrc",
  "credentials*",
  "secrets.*",
];

const ALLOWED_NAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);

function globToRegExp(glob: string): RegExp {
  const body = glob
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

const DEFAULT_MATCHERS = DEFAULT_PATTERNS.map(globToRegExp);

export function isExcludedPath(absPath: string, extraPatterns: string[] = []): boolean {
  const name = basename(absPath).toLowerCase();
  if (extraPatterns.some((p) => globToRegExp(p.trim()).test(name))) return true;
  if (!ALLOWED_NAMES.has(name) && !name.endsWith(".pub") && DEFAULT_MATCHERS.some((re) => re.test(name))) return true;
  return dirname(absPath)
    .split(/[\\/]/)
    .some((seg) => SECRET_DIRS.has(seg.toLowerCase()));
}
