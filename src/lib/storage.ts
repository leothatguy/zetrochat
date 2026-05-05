import type { StoredKeyEnvelope } from "@/lib/types";

const DB_NAME = "zetrochat-secure-db";
const DB_VERSION = 1;
const STORE_NAME = "secure_state";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Failed to open secure storage."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = operation(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Secure storage operation failed."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(new Error("Secure storage transaction failed."));
  });
}

export async function saveKeyEnvelope(envelope: StoredKeyEnvelope): Promise<void> {
  await withStore("readwrite", (store) => store.put(envelope, `key-envelope:${envelope.userId}`));
}

export async function getKeyEnvelope(userId: string): Promise<StoredKeyEnvelope | null> {
  const result = await withStore("readonly", (store) => store.get(`key-envelope:${userId}`));
  return result ?? null;
}

export async function removeKeyEnvelope(userId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(`key-envelope:${userId}`));
}

