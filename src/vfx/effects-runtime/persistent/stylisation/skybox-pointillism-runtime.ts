import type { AppBase, Material } from 'playcanvas';

import { SKYBOX_POINTILLISM_UNIFORM_NAMES as SKY } from './skybox-pointillism-shaders';

type SkyRuntimeScene = {
    sky?: {
        resetSkyMesh?: () => void;
        updateSkyMesh?: () => void;
        skyMesh?: { meshInstance?: { material?: Material } };
    };
};

export type SkyboxPointillismUniformValues = {
    strength: number;
    angularSpacing: number;
    rxCellScale: number;
    dotRadiusSlope: number;
    dotRadiusPx: number;
    dotScale: number;
    gapSpacing: number;
    saturation: number;
    levelRange: number;
    warmCoolSplit: number;
    colorVibration: number;
    contrastDotMix: number;
    seed: number;
    strokeLength: number;
    strokeWidth: number;
    brushAspect: number;
    brushHardness: number;
    paintGrain: number;
    paperStrength: number;
    paperTint: [number, number, number];
};

/** SkyMaterial 在创建时拷贝 skyboxPS，chunk patch 后必须重建 mesh 才会生效。 */
export const refreshSkyboxMaterialShader = (app: AppBase): Material | null => {
    const sky = (app.scene as SkyRuntimeScene).sky;
    if (!sky?.resetSkyMesh || !sky?.updateSkyMesh) {
        return null;
    }
    sky.resetSkyMesh();
    sky.updateSkyMesh();
    return sky.skyMesh?.meshInstance?.material ?? null;
};

export const applySkyboxPointillismUniforms = (app: AppBase, values: SkyboxPointillismUniformValues): void => {
    const scalarPairs: ReadonlyArray<[string, number]> = [
        [SKY.strength, values.strength],
        [SKY.angularSpacing, values.angularSpacing],
        [SKY.rxCellScale, values.rxCellScale],
        [SKY.dotRadiusSlope, values.dotRadiusSlope],
        [SKY.dotRadiusPx, values.dotRadiusPx],
        [SKY.dotScale, values.dotScale],
        [SKY.gapSpacing, values.gapSpacing],
        [SKY.saturation, values.saturation],
        [SKY.levelRange, values.levelRange],
        [SKY.warmCoolSplit, values.warmCoolSplit],
        [SKY.colorVibration, values.colorVibration],
        [SKY.contrastDotMix, values.contrastDotMix],
        [SKY.seed, values.seed],
        [SKY.strokeLength, values.strokeLength],
        [SKY.strokeWidth, values.strokeWidth],
        [SKY.brushAspect, values.brushAspect],
        [SKY.brushHardness, values.brushHardness],
        [SKY.paintGrain, values.paintGrain],
        [SKY.paperStrength, values.paperStrength]
    ];

    const scope = app.graphicsDevice.scope;
    for (const [name, value] of scalarPairs) {
        scope.resolve(name).setValue(value);
    }
    scope.resolve('uPointillismPaperTint').setValue(values.paperTint);

    const material = (app.scene as SkyRuntimeScene).sky?.skyMesh?.meshInstance?.material;
    if (!material) {
        return;
    }
    for (const [name, value] of scalarPairs) {
        material.setParameter(name, value);
    }
    material.setParameter('uPointillismPaperTint', values.paperTint);
    material.update();
};
