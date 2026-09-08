const DB_NAME = 'supersplat-project-pack';
const STORE = 'pending';
const KEY = 'pack';

export type PendingProjectPack = {
    settings: unknown;
    files: Array<{ path: string; blob: Blob }>;
};

function openPackDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('打开项目包缓存失败'));
    });
}

export async function savePendingProjectPack(pack: PendingProjectPack): Promise<void> {
    const db = await openPackDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('写入项目包缓存失败'));
        tx.objectStore(STORE).put(pack, KEY);
    });
    db.close();
}

export async function takePendingProjectPack(): Promise<PendingProjectPack | undefined> {
    const db = await openPackDb();
    const pack = await new Promise<PendingProjectPack | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const getReq = store.get(KEY);
        getReq.onsuccess = () => {
            store.delete(KEY);
            resolve(getReq.result as PendingProjectPack | undefined);
        };
        getReq.onerror = () => reject(getReq.error ?? new Error('读取项目包缓存失败'));
    });
    db.close();
    return pack;
}
