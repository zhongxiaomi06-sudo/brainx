/** skills.js — SKILL.md 技能发现与加载(零依赖 frontmatter 解析)。
 * 发现源:恒扫仓库 <root>/skills/*(随部署走);BRAINX_AGENT_GLOBAL_SKILLS=1 时
 * 加扫 ~/.agents/skills/brainx-*(桌面全局技能,云版默认关——全局目录条目杂且费 token)。
 * frontmatter 只取 name/description 两个单行字段,不引 YAML 库。 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isPathInside } from '../server-http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_SKILLS_DIR = join(ROOT, 'skills');
export const GLOBAL_SKILLS_DIR = join(homedir(), '.agents', 'skills');
const BODY_CAP = 20000;

/** 解析 SKILL.md:--- 包围的 frontmatter 取 name/description,其余为正文。不合规返回 null。 */
export function parseSkillFile(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const field = (key) => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  };
  const name = field('name');
  const description = field('description');
  if (!name || !description) return null;
  return { name, description, body };
}

/** 发现技能,返回 Map(name → {name, description, path, root})。正文不预读,loadSkill 懒加载。 */
export function discoverSkills({ includeGlobal = process.env.BRAINX_AGENT_GLOBAL_SKILLS === '1' } = {}) {
  const roots = [{ dir: REPO_SKILLS_DIR, filter: () => true }];
  if (includeGlobal) roots.push({ dir: GLOBAL_SKILLS_DIR, filter: (d) => d.startsWith('brainx-') });
  const index = new Map();
  for (const { dir, filter } of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!filter(entry)) continue;
      const fp = join(dir, entry, 'SKILL.md');
      try { if (!statSync(fp).isFile()) continue; } catch { continue; }
      try {
        const parsed = parseSkillFile(readFileSync(fp, 'utf8'));
        if (parsed && !index.has(parsed.name)) {
          index.set(parsed.name, { name: parsed.name, description: parsed.description, path: fp, root: dir });
        }
      } catch { /* 单个坏文件不拖垮发现 */ }
    }
  }
  return index;
}

/** 加载技能正文(截 20k);路径双保险校验,未知名返回 null。 */
export function loadSkill(index, name) {
  const hit = index?.get(name);
  if (!hit) return null;
  if (!isPathInside(hit.root, hit.path)) return null;
  try {
    const parsed = parseSkillFile(readFileSync(hit.path, 'utf8'));
    if (!parsed) return null;
    return { name: hit.name, description: hit.description, body: parsed.body.slice(0, BODY_CAP) };
  } catch {
    return null;
  }
}
