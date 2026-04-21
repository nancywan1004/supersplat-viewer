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
    private pointerClickHandlers: PointerClickHandler[] = [];

    registerPointerClickHandler(handler: PointerClickHandler): () => void {
        this.pointerClickHandlers.push(handler);
        this.pointerClickHandlers.sort((a, b) => b.priority - a.priority);
        return () => this.unregisterPointerClickHandler(handler.id);
    }

    dispatchPointerClick(ctx: PointerClickClaimContext): PointerClickDispatchResult {
        for (const handler of this.pointerClickHandlers) {
            if (!handler.handle(ctx)) continue;
            return { claimed: true, claimedBy: handler.id };
        }
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
