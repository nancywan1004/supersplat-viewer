import { GSplatComponentSystem } from 'playcanvas';

export type NativeStreamingSnapshot = {
    pendingNodes: number;
    refinementRatio: number;
    ready: boolean;
};

/** 引擎原生 octree streaming：通过 GSplatComponentSystem EVENT_FRAMEREADY 观测 loadingCount */
export class NativeStreamingObserver {
    private loadingCount = 0;
    private ready = false;

    attach(gsplatSystem: GSplatComponentSystem): void {
        gsplatSystem.on(
            GSplatComponentSystem.EVENT_FRAMEREADY,
            (_cam: unknown, _layer: unknown, ready: boolean, loadingCount: number) => {
                this.ready = ready;
                this.loadingCount = loadingCount;
            }
        );
    }

    snapshot(): NativeStreamingSnapshot {
        const clear = this.ready && this.loadingCount === 0;
        return {
            pendingNodes: this.loadingCount,
            refinementRatio: clear ? 1 : 0,
            ready: this.ready
        };
    }
}
