/** Fetch every row using a fresh, stably ordered query for each page. */
export async function pageAll<T>(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{
      data: T[] | null;
      error: { message: string } | null;
    }>;
  },
) {
  const data: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const result = await build().range(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    const rows = result.data ?? [];
    data.push(...rows);
    if (rows.length < pageSize) return { data, error: null };
  }
}
