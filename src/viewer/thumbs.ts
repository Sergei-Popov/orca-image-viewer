// Thumbnails of the open document by image id. Ids restart at 0 for every file, and Orca sends a
// file again when it changes outside, so entries belong to one generation of the document: asking
// with another generation drops them all.

export class ThumbCache<T> {
  private generation = -1
  private readonly entries = new Map<number, T>()

  get(generation: number, id: number): T | undefined {
    this.sync(generation)
    return this.entries.get(id)
  }

  set(generation: number, id: number, value: T): void {
    this.sync(generation)
    this.entries.set(id, value)
  }

  get size(): number {
    return this.entries.size
  }

  private sync(generation: number): void {
    if (generation === this.generation) return
    this.entries.clear()
    this.generation = generation
  }
}
