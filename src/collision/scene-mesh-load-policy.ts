import type { SceneMeshLoadIntent } from './scene-mesh-load-intent';

export type SceneMeshNeedInput = {
    hasUrl: boolean;
    hasMeshUrl: boolean;
    wantCollision: boolean;
    wantShadow: boolean;
    canGenerate: boolean;
    intent?: SceneMeshLoadIntent;
};

/** generate 仅显式 SHADOW_SET / COLLISION_SET / regenerate；canGenerate 不能当成「已经需要网格」。 */
export function shouldFetchCollisionFromUniverse(canGenerate: boolean, intent?: SceneMeshLoadIntent): boolean {
    if (!canGenerate) {
        return false;
    }
    return intent?.wantCollision === true || intent?.wantShadow === true;
}

/** 是否应加载 / 生成 scene mesh（不含 failed 重试策略）。 */
export function shouldLoadSceneMesh(input: SceneMeshNeedInput): boolean {
    const needCollision = input.hasUrl && input.wantCollision;
    const needShadowSceneMesh = input.wantShadow && input.hasMeshUrl;
    const needUniverse = !input.hasUrl && shouldFetchCollisionFromUniverse(input.canGenerate, input.intent);
    return needCollision || needShadowSceneMesh || needUniverse;
}
