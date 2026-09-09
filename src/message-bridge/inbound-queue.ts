/**
 * message-bridge 入站串行队列：后一条等前一条 settle（含失败）后再跑。
 * 避免 `EDIT_MODE_SET` await restore 期间 `LIGHT_*` / `PROJECT_SAVE` 交错，把进编辑 snapshot 盖掉刚写入的 settings。
 */

export type SerialAsyncQueue = {
    enqueue(task: () => void | Promise<void>): Promise<void>;
};

export function createSerialAsyncQueue(onError?: (err: unknown) => void): SerialAsyncQueue {
    let tail: Promise<void> = Promise.resolve();
    return {
        enqueue(task) {
            const run = tail.then(() => task());
            tail = run.then(
                () => undefined,
                (err) => {
                    onError?.(err);
                }
            );
            return run;
        }
    };
}
