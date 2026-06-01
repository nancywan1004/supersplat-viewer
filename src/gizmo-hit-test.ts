import type { Global } from './types';

type GizmoHitTest = (canvasX: number, canvasY: number) => boolean;

let sceneGizmoHitTest: GizmoHitTest | null = null;

export function setSceneGizmoHitTest(fn: GizmoHitTest | null): void {
    sceneGizmoHitTest = fn;
}

/** 屏幕坐标是否命中当前场景 Transform Gizmo（供输入模块避让）。 */
export function hitSceneGizmoAtClient(global: Global, clientX: number, clientY: number): boolean {
    if (!global.state.editMode || !sceneGizmoHitTest) return false;
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return false;
    return sceneGizmoHitTest(x, y);
}
