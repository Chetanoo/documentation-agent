// Runs async tasks with at most `limit` in flight at once.
// Results come back in the same order as the tasks.
export async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) break;
      results[i] = await task();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
