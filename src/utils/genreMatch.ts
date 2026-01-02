export type GenreLite = { id: number; name: string };

export const tokenizeWords = (value: string) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

export const splitGenreParts = (genreName: string) =>
  genreName
    .split(/[/,&]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean);

export const isTokenSubset = (a: Set<string>, b: Set<string>) => {
  for (const t of a) {
    if (!b.has(t)) return false;
  }
  return true;
};

// Token-based match with pruning of less-specific genres.
// Example: If "Science Fiction" matches, do not also return "Fiction".
export const matchGenresFromCategories = (
  categories: string[],
  genres: GenreLite[]
): GenreLite[] => {
  if (!categories?.length || !genres?.length) return [];

  const categoryTokenSets = categories
    .map((c) => new Set(tokenizeWords(c)))
    .filter((s) => s.size > 0);

  const matchedById = new Map<number, GenreLite>();
  const genreTokensById = new Map<number, Set<string>>();

  for (const g of genres) {
    const fullTokens = new Set(tokenizeWords(g.name));
    if (fullTokens.size === 0) continue;
    genreTokensById.set(g.id, fullTokens);

    const parts = splitGenreParts(g.name);
    const partTokenSets = parts
      .map((p) => new Set(tokenizeWords(p)))
      .filter((s) => s.size > 0);

    for (const catTokens of categoryTokenSets) {
      const matchesThisCategory = partTokenSets.some((genrePartTokens) =>
        isTokenSubset(genrePartTokens, catTokens)
      );
      if (matchesThisCategory) {
        matchedById.set(g.id, g);
        break;
      }
    }
  }

  const matched = Array.from(matchedById.values());
  const matchedIds = matched.map((g) => g.id);
  const prunedIds = new Set<number>(matchedIds);

  for (const a of matchedIds) {
    const aTokens = genreTokensById.get(a);
    if (!aTokens) continue;

    for (const b of matchedIds) {
      if (a === b) continue;
      const bTokens = genreTokensById.get(b);
      if (!bTokens) continue;
      if (aTokens.size >= bTokens.size) continue;

      if (isTokenSubset(aTokens, bTokens)) {
        prunedIds.delete(a);
        break;
      }
    }
  }

  return matched.filter((g) => prunedIds.has(g.id));
};
