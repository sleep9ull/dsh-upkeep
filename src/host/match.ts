/**
 * Mechanical matching: which migration-guide items actually touch a plugin's
 * recovered surfaces. This is the deterministic half of "targeted": the model
 * only ever sees items that mention something the plugin demonstrably uses.
 */

import type { GuideSet } from './guides.js'
import { inventoryHits, type SurfaceHit, type SurfaceInventory } from './surfaces.js'

/** One guide item that mentions the plugin's surfaces. */
export interface GuideMatch {
  version: string
  item: string
  description: string
  change: string
  migration: string
  matchedSurfaces: SurfaceHit[]
  score: number
}

/** How much a surface kind counts toward a match. */
const WEIGHTS: Record<SurfaceHit['kind'], number> = {
  package: 3,
  service: 2,
  event: 3,
  tool: 3,
  command: 3,
  slot: 3,
  'config-key': 1,
  'row-id': 1,
}

/** Whether `token` appears in `text` on identifier boundaries. */
function mentions(text: string, token: string): boolean {
  const haystack = text.toLowerCase()
  const needle = token.toLowerCase()
  const boundary = (character: string | undefined): boolean =>
    character === undefined || !/[a-z0-9_]/.test(character)
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    if (boundary(haystack[index - 1]) && boundary(haystack[index + needle.length])) return true
    index = haystack.indexOf(needle, index + 1)
  }
  return false
}

/**
 * Match guide items against one plugin's surfaces.
 * @returns matching items, strongest first; items with no surface hit are dropped.
 */
export function matchGuides(guides: GuideSet, inventory: SurfaceInventory): GuideMatch[] {
  const hits = inventoryHits(inventory)
  const matches: GuideMatch[] = []
  for (const item of guides.items) {
    const text = [item.description, item.change, item.migration].join('\n')
    const matched: SurfaceHit[] = []
    let score = 0
    for (const hit of hits) {
      if (!mentions(text, hit.value)) continue
      matched.push(hit)
      score += WEIGHTS[hit.kind]
    }
    if (score === 0) continue
    matches.push({
      version: item.version,
      item: item.item,
      description: item.description,
      change: item.change,
      migration: item.migration,
      matchedSurfaces: matched,
      score,
    })
  }
  return matches.sort((left, right) => right.score - left.score
    || (left.version === right.version ? left.item.localeCompare(right.item) : left.version < right.version ? -1 : 1))
}

/** A compact impact summary the panel reads. */
export interface ImpactSummary {
  matched: number
  versions: string[]
  top: Array<{ version: string; item: string; description: string }>
}

/** Compress matches into the summary stored with a check. */
export function summarizeMatches(matches: GuideMatch[]): ImpactSummary {
  return {
    matched: matches.length,
    versions: [...new Set(matches.map(match => match.version))],
    top: matches.slice(0, 5).map(match => ({ version: match.version, item: match.item, description: match.description })),
  }
}
