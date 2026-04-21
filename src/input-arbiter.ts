import type { Vec3 } from 'playcanvas';

import type { Global } from './types';

type PointerClickClaimContext = {
    global: Global;
    pointerEvent: PointerEvent;
    clientX: number;
    clientY: number;
    worldPosition: Vec3 | null;
};

type PointerClickHandler = {
    id: string;
    priority: number;
    handle: (ctx: PointerClickClaimContext) => boolean;
};

type PointerClickDispatchResult = {
    claimed: boolean;
    claimedBy: string | null;
};

class InputArbiter {
    // 所有点击消费者按优先级统一收敛在这里，
    // 避免各模块各自监听 DOM 造成同一次点击被多处并发消费。
    private pointerClickHandlers: PointerClickHandler[] = [];

    registerPointerClickHandler(handler: PointerClickHandler): () => void {
        this.pointerClickHandlers.push(handler);
        // 高优先级先尝试 claim；同优先级保持注册顺序。
        this.pointerClickHandlers.sort((a, b) => b.priority - a.priority);
        // 返回解绑函数，便于 facade 在 onExit/dispose 时回收监听。
        return () => this.unregisterPointerClickHandler(handler.id);
    }

    dispatchPointerClick(ctx: PointerClickClaimContext): PointerClickDispatchResult {
        for (const handler of this.pointerClickHandlers) {
            if (!handler.handle(ctx)) continue;
            // 一旦某个 handler claim 成功，当前点击链路立即终止。
            return { claimed: true, claimedBy: handler.id };
        }
        // 无 claim 时由调用方决定是否继续走通用事件广播。
        return { claimed: false, claimedBy: null };
    }

    private unregisterPointerClickHandler(id: string): void {
        const index = this.pointerClickHandlers.findIndex((handler) => handler.id === id);
        if (index >= 0) {
            this.pointerClickHandlers.splice(index, 1);
        }
    }
}

const initInputArbiter = (global: Global): InputArbiter => {
    const arbiter = new InputArbiter();
    (global as any).__inputArbiter = arbiter;
    return arbiter;
};

export type {
    PointerClickClaimContext,
    PointerClickHandler,
    PointerClickDispatchResult
};
export { InputArbiter, initInputArbiter };
