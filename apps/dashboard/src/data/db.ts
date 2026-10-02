export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("fire-dashboard-v1", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const claims = db.createObjectStore("claims", {
        keyPath: "id",
        autoIncrement: true,
      });
      claims.createIndex("key", "key", { unique: true });
      db.createObjectStore("leases");
      db.createObjectStore("cards");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(Error("storage"));
    r.onblocked = () => reject(Error("storage_blocked"));
  });
}
export async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(name, mode);
    let result: T;
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(Error("storage"));
    };
    try {
      run(tx.objectStore(name), (v) => {
        result = v;
      });
    } catch {
      tx.abort();
    }
  });
}
