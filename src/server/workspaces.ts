import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.KENNOOK_DATA_ROOT ?? './data';
const REGISTRY_PATH = path.join(DATA_ROOT, 'workspaces.json');

export const DEFAULT_WORKSPACE_SLUG = 'personal';
export const COOKIE_NAME = 'kennook_workspace';

export interface Workspace {
  slug: string;
  name: string;
  createdAt: number;
}

interface Registry {
  version: 1;
  workspaces: Workspace[];
}

function ensureDataRoot() {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
}

function readRegistry(): Registry {
  ensureDataRoot();
  if (!fs.existsSync(REGISTRY_PATH)) {
    const initial: Registry = {
      version: 1,
      workspaces: [
        { slug: DEFAULT_WORKSPACE_SLUG, name: 'Personal', createdAt: Date.now() },
      ],
    };
    writeRegistry(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw) as Registry;
  } catch {
    throw new Error(`Could not parse ${REGISTRY_PATH}. Delete it to reset, or repair it manually.`);
  }
}

function writeRegistry(registry: Registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

export function listWorkspaces(): Workspace[] {
  return readRegistry().workspaces;
}

export function getWorkspaceBySlug(slug: string): Workspace | null {
  return readRegistry().workspaces.find((w) => w.slug === slug) ?? null;
}

export function resolveWorkspace(slug: string | undefined | null): Workspace {
  const wanted = slug ?? DEFAULT_WORKSPACE_SLUG;
  const found = getWorkspaceBySlug(wanted);
  if (found) return found;
  // Fall back to default if requested workspace doesn't exist.
  const fallback = getWorkspaceBySlug(DEFAULT_WORKSPACE_SLUG);
  if (!fallback) throw new Error('Default workspace missing from registry');
  return fallback;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function createWorkspace(name: string): Workspace {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Workspace name is required');
  const slug = slugify(trimmed);
  if (!slug) throw new Error('Workspace name must contain at least one letter or number');

  const registry = readRegistry();
  if (registry.workspaces.some((w) => w.slug === slug)) {
    throw new Error(`Workspace "${slug}" already exists`);
  }

  const ws: Workspace = { slug, name: trimmed, createdAt: Date.now() };
  registry.workspaces.push(ws);
  writeRegistry(registry);

  // Pre-create workspace directories so the indexer + DB init don't race.
  fs.mkdirSync(workspaceThumbnailsDir(slug), { recursive: true });

  return ws;
}

export function workspaceRoot(slug: string): string {
  return path.join(DATA_ROOT, slug);
}

export function workspaceDbPath(slug: string): string {
  return path.join(workspaceRoot(slug), 'kennook.db');
}

export function workspaceThumbnailsDir(slug: string): string {
  return path.join(workspaceRoot(slug), 'thumbnails');
}

export function parseWorkspaceCookie(cookieHeader: string | null | undefined): string {
  if (!cookieHeader) return DEFAULT_WORKSPACE_SLUG;
  const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return DEFAULT_WORKSPACE_SLUG;
  return decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) || DEFAULT_WORKSPACE_SLUG;
}
