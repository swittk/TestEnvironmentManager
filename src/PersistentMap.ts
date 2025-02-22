import { Database, Key, open } from 'lmdb';
import path from 'path';

// Define allowed key types based on LMDB's requirements
type ValidKey = Key;

export class PersistentMap<K extends ValidKey, V> implements Map<K, V> {
    private db: Database;
    private _size: number;

    constructor(dbPath: string = './persistent_map') {
        const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
        
        this.db = open({
            path: absolutePath,
            // schema: null,
            compression: false,
        });
        
        this._size = this.db.getCount();
    }

    set(key: K, value: V): this {
        const previouslyHadKey = this.db.get(key) !== undefined;
        this.db.putSync(key, value);
        
        if (!previouslyHadKey) {
            this._size++;
        }
        
        return this;
    }

    get(key: K): V | undefined {
        return this.db.get(key) as V | undefined;
    }

    has(key: K): boolean {
        return this.db.get(key) !== undefined;
    }

    delete(key: K): boolean {
        const hadKey = this.has(key);
        if (hadKey) {
            this.db.removeSync(key);
            this._size--;
            return true;
        }
        return false;
    }

    clear(): void {
        this.db.clearSync();
        this._size = 0;
    }

    get size(): number {
        return this._size;
    }

    *entries(): IterableIterator<[K, V]> {
        for (const { key, value } of this.db.getRange()) {
            yield [key as K, value as V];
        }
    }

    *keys(): IterableIterator<K> {
        for (const { key } of this.db.getRange()) {
            yield key as K;
        }
    }

    *values(): IterableIterator<V> {
        for (const { value } of this.db.getRange()) {
            yield value as V;
        }
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void {
        for (const [key, value] of this.entries()) {
            callbackfn.call(thisArg, value, key, this);
        }
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this.entries();
    }

    get [Symbol.toStringTag](): string {
        return 'PersistentMap';
    }

    close(): void {
        this.db.close();
    }
}