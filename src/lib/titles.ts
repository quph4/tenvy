/**
 * Provider titles carry their metadata in brackets: "Mickey's Once Upon a
 * Christmas [KIDS] [1999]", "Dune: Part Two (2024) [4K] [Multi-Sub]".
 * Split that into a clean display title and the tags.
 */
export interface ParsedTitle {
  title: string
  /** Bracketed tags other than the year, e.g. ["KIDS", "4K"]. */
  tags: string[]
  /** A year found in the brackets or a trailing " - 2009". */
  year: number | null
}

const TRAILING_TAG = /\s*[[(]([^\])]{1,24})[\])]\s*$/

export function parseTitle(name: string): ParsedTitle {
  let title = name.trim()
  const tags: string[] = []
  let year: number | null = null
  // Peel tags off the end; stop at the first non-tag so titles like
  // "Movie (Director's Cut)" keep their parenthetical when it's not last.
  for (let i = 0; i < 6; i++) {
    const m = title.match(TRAILING_TAG)
    if (!m || m.index === undefined || m.index === 0) break
    const tag = m[1].trim()
    if (/^(19|20)\d\d$/.test(tag)) year ??= Number(tag)
    else tags.unshift(tag)
    title = title.slice(0, m.index).trim()
  }
  // API titles put the year after a dash: "Zombieland - 2009".
  const dashYear = title.match(/\s+[-–]\s+((19|20)\d\d)$/)
  if (dashYear && dashYear.index) {
    year ??= Number(dashYear[1])
    title = title.slice(0, dashYear.index).trim()
  }
  // Leading "EN - " / "|SE| " style prefixes.
  title = title.replace(/^(\|[A-Z]{2,3}\|\s*|[A-Z]{2,3}\s*[-:|]\s+)/, '')
  return { title: title || name, tags, year }
}

export function displayTitle(name: string): string {
  return parseTitle(name).title
}
