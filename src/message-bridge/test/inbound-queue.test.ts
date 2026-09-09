/**
 * 入站串行队列自检。
 *
 *   npx --yes tsx src/message-bridge/test/inbound-queue.test.ts
 */

import { createSerialAsyncQueue } from '../inbound-queue';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

async function testLaterWaitsForEarlier(): Promise<void> {
    const order: string[] = [];
    const q = createSerialAsyncQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const first = q.enqueue(async () => {
        order.push('a-start');
        await gate;
        order.push('a-end');
    });
    const second = q.enqueue(async () => {
        order.push('b');
    });

    await Promise.resolve();
    assert(order.join(',') === 'a-start', `second must not start before first settles: ${order.join(',')}`);
    release();
    await Promise.all([first, second]);
    assert(order.join(',') === 'a-start,a-end,b', `expected a then b, got ${order.join(',')}`);
}

async function testFailureDoesNotStallQueue(): Promise<void> {
    const errors: unknown[] = [];
    const q = createSerialAsyncQueue((err) => {
        errors.push(err);
    });
    const failed = q.enqueue(async () => {
        throw new Error('boom');
    });
    await failed.then(
        () => {
            throw new Error('first task should reject');
        },
        () => undefined
    );
    await q.enqueue(() => undefined);
    assert(errors.length === 1, 'onError once');
}

async function main(): Promise<void> {
    await testLaterWaitsForEarlier();
    await testFailureDoesNotStallQueue();
    console.log('all inbound-queue tests passed');
}

void main();
