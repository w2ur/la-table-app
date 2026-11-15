/** One boolean the shell watches (a new service worker waiting). */
export class Flag {
  private value = false;
  private readonly listeners = new Set<() => void>();

  get(): boolean {
    return this.value;
  }

  set(value: boolean): void {
    if (value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
