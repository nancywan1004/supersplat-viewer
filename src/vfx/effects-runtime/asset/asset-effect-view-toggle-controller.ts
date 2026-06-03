import {
    Picker as EnginePicker,
    type AppBase,
    type CameraComponent,
    type Entity,
    type GSplatComponent,
    type MeshInstance
} from 'playcanvas';

import { pickScenePlacedEntryAtScreen } from '../../../scene-assets/scene-asset-selection-pick';
import {
    findAssetMorphOwnerTargetId,
    patchAssetRuntimeMirror,
    readAssetInstanceParams
} from '../../../settings-serialize/effects-sync';
import { ASSET_EFFECT_TYPE_VALUES, type AssetEffectType } from '../effect-types';
import {
    readMorphKeyframeEntityIds,
    resolveAssetEffectGsplatEntity,
    resolveMorphKeyframeEntitiesFromEffectParams,
    type AssetEffectStartEntities
} from './asset-effect-entity';
import { getDefaultWobbleEffectParams } from './wobble-effect-params';
import type { InputArbiter, PointerClickClaimContext } from '../../../input-arbiter';
import type { ExperienceSettings } from '../../../schemas/v2';
import type { Global, ScenePlacedItem } from '../../../types';

type IdPicker = {
    resize: (w: number, h: number) => void;
    prepare: (camera: CameraComponent, scene: AppBase['scene'], layers: unknown[]) => void;
    getSelectionAsync: (x: number, y: number, w?: number, h?: number) => Promise<Array<MeshInstance | GSplatComponent>>;
};

type ToggleMode = 'idle' | 'user';

const PICKER_SCALE = 0.5;
const GSPLAT_MORPH_TYPE = ASSET_EFFECT_TYPE_VALUES[0];
const GSPLAT_WOBBLE_TYPE = ASSET_EFFECT_TYPE_VALUES[1];

function getCanvasPickPoint(global: Global, clientX: number, clientY: number): {
    pickX: number;
    pickY: number;
    pickW: number;
    pickH: number;
} | null {
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    if (offsetX < 0 || offsetY < 0 || offsetX > rect.width || offsetY > rect.height) {
        return null;
    }

    const pickW = Math.max(1, Math.floor(global.app.graphicsDevice.width * PICKER_SCALE));
    const pickH = Math.max(1, Math.floor(global.app.graphicsDevice.height * PICKER_SCALE));
    return {
        pickX: Math.floor((offsetX / rect.width) * pickW),
        pickY: Math.floor((offsetY / rect.height) * pickH),
        pickW,
        pickH
    };
}

function entityForWobbleTarget(global: Global, targetId: string): Entity | null {
    return resolveAssetEffectGsplatEntity(global, targetId);
}

function entitiesForUserEffect(
    global: Global,
    targetId: string,
    type: AssetEffectType,
    effectParams: Record<string, unknown>
): AssetEffectStartEntities | undefined {
    if (type === GSPLAT_WOBBLE_TYPE) {
        const primary = entityForWobbleTarget(global, targetId);
        return primary ? { primary } : undefined;
    }
    if (type === GSPLAT_MORPH_TYPE) {
        const keyframeEntities = resolveMorphKeyframeEntitiesFromEffectParams(global, effectParams);
        return keyframeEntities ? { keyframeEntities } : undefined;
    }
    return undefined;
}

function modeFromStartPayload(payload: {
    targetId?: string;
    type?: string;
    effectId?: string;
    params?: { effectParams?: Record<string, unknown> };
}): { targetId: string; mode: ToggleMode } | null {
    if (!payload?.targetId) {
        return null;
    }
    const type = payload.type ?? payload.effectId;
    const effectParams = payload.params?.effectParams;
    const isIdle =
        type === GSPLAT_WOBBLE_TYPE &&
        effectParams?.motionMode === 'deepMeditation';
    return {
        targetId: payload.targetId,
        mode: isIdle ? 'idle' : 'user'
    };
}

export class AssetEffectViewToggleController {
    private readonly _global: Global;

    private readonly _toggleModeByTargetId = new Map<string, ToggleMode>();

    private _picker: IdPicker | null = null;

    private _detachPointerClick: (() => void) | null = null;

    private _disposed = false;

    private _pickInFlight = false;

    constructor(global: Global) {
        this._global = global;
        const inputArbiter = (global as Global & { __inputArbiter?: InputArbiter }).__inputArbiter;
        this._detachPointerClick = inputArbiter?.registerPointerClickHandler({
            id: 'asset-effect.view-toggle',
            priority: 20,
            handle: this._onPointerClick
        }) ?? null;

        global.events.on('assetEffect:start', this._onAssetEffectStart);
        global.events.on('assetEffect:stop', this._onAssetEffectStop);
        global.events.on('assetEffect:stopped', this._onAssetEffectStop);
        global.events.on('sceneAssets:cleared', this._onSceneAssetsCleared);
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._detachPointerClick?.();
        this._detachPointerClick = null;
        this._global.events.off('assetEffect:start', this._onAssetEffectStart);
        this._global.events.off('assetEffect:stop', this._onAssetEffectStop);
        this._global.events.off('assetEffect:stopped', this._onAssetEffectStop);
        this._global.events.off('sceneAssets:cleared', this._onSceneAssetsCleared);
        this._toggleModeByTargetId.clear();
    }

    private readonly _onPointerClick = ({ clientX, clientY }: PointerClickClaimContext): boolean => {
        if (this._disposed || this._global.state.editMode === true || this._pickInFlight) {
            return false;
        }
        const pickPoint = getCanvasPickPoint(this._global, clientX, clientY);
        if (!pickPoint) {
            return false;
        }

        this._pickInFlight = true;
        this._pickAndToggle(clientX, clientY, pickPoint)
        .catch(err => console.warn('[AssetEffectViewToggle] click toggle failed', err))
        .finally(() => {
            this._pickInFlight = false;
        });
        return false;
    };

    private readonly _onAssetEffectStart = (payload: {
        targetId?: string;
        type?: string;
        effectId?: string;
        params?: { effectParams?: Record<string, unknown> };
    }) => {
        const next = modeFromStartPayload(payload);
        if (!next) {
            return;
        }
        this._toggleModeByTargetId.set(next.targetId, next.mode);
    };

    private readonly _onAssetEffectStop = (payload: { targetId?: string }) => {
        if (payload?.targetId) {
            this._toggleModeByTargetId.delete(payload.targetId);
        }
    };

    private readonly _onSceneAssetsCleared = () => {
        this._toggleModeByTargetId.clear();
    };

    private async _pickAndToggle(
        clientX: number,
        clientY: number,
        pickPoint: { pickX: number; pickY: number; pickW: number; pickH: number }
    ): Promise<void> {
        const { app, camera } = this._global;
        const picker = this._ensurePicker(pickPoint.pickW, pickPoint.pickH);
        const entry = await pickScenePlacedEntryAtScreen(
            this._global,
            app,
            camera,
            picker,
            pickPoint.pickX,
            pickPoint.pickY,
            clientX,
            clientY
        );
        if (this._disposed || !entry || entry.assetType !== 'gaussian') {
            return;
        }

        console.log('[AssetEffectViewToggle] picked entry', {
            id: entry.id,
            name: entry.name,
            assetType: entry.assetType,
            entityName: entry.entity?.name,
            clientX,
            clientY
        });
        
        this._toggleEntry(entry);
    }

    private _toggleEntry(entry: ScenePlacedItem): void {
        const settings = this._global.settings as ExperienceSettings;
        const targetId = findAssetMorphOwnerTargetId(settings, entry.id) ?? entry.id;
        const inst = readAssetInstanceParams(settings, targetId);
        if (!inst || inst.enable === false || inst.autoStart !== true) {
            return;
        }

        const effectParams = inst.effectParams ?? {};
        if (inst.type === GSPLAT_MORPH_TYPE) {
            const keyframes = readMorphKeyframeEntityIds(effectParams);
            if (!keyframes?.includes(entry.id)) {
                return;
            }
        } else if (targetId !== entry.id) {
            return;
        }

        if (this._toggleModeByTargetId.get(targetId) === 'user') {
            this._startIdle(targetId);
            return;
        }
        this._startUserEffect(targetId, inst.type as AssetEffectType, effectParams);
    }

    private _startIdle(targetId: string): void {
        const primary = entityForWobbleTarget(this._global, targetId);
        if (!primary) {
            return;
        }
        const effectParams = getDefaultWobbleEffectParams('deepMeditation');
        this._global.events.fire('assetEffect:start', {
            targetId,
            type: GSPLAT_WOBBLE_TYPE,
            params: { effectParams },
            entities: { primary }
        });
        patchAssetRuntimeMirror(this._global.state, targetId, {
            activeType: GSPLAT_WOBBLE_TYPE,
            status: 'playing'
        });
    }

    private _startUserEffect(
        targetId: string,
        type: AssetEffectType,
        effectParams: Record<string, unknown>
    ): void {
        const entities = entitiesForUserEffect(this._global, targetId, type, effectParams);
        this._global.events.fire('assetEffect:start', {
            targetId,
            type,
            params: { effectParams },
            entities
        });
        patchAssetRuntimeMirror(this._global.state, targetId, {
            activeType: type,
            status: 'playing'
        });
    }

    private _ensurePicker(width: number, height: number): IdPicker {
        if (!this._picker) {
            this._picker = new EnginePicker(this._global.app, width, height, false) as unknown as IdPicker;
        } else {
            this._picker.resize(width, height);
        }
        return this._picker;
    }
}

export function createAssetEffectViewToggleController(global: Global): AssetEffectViewToggleController {
    return new AssetEffectViewToggleController(global);
}
