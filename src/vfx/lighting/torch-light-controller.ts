import { Color, Entity, Vec3 } from 'playcanvas';

import { ensureTorchLight } from '../../settings-serialize/settings-serialize-helper';
import { ensureViewSettings } from '../../view-settings';
import { setTorchCursorActive } from '../../placement-cursor';
import type { Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import type { TorchLightSettings } from '../../schemas/v2-custom';

/**
 * 手电筒（全局单例，运行时类型为 PlayCanvas **point light**）。
 *
 * **方案 A（无 pick 版）**：位置完全由「鼠标 client 坐标 + 用户可调的 `exploreDistance`」决定。
 *
 * - 实体名固定为 `torchLight`，挂在 `app.root` 下独立容器（不进 `pointLights`，
 *   规避 `updatePointLightsFromSettings` 的 destroy 误删）
 * - 参数（颜色 / 强度 / range / exploreDistance）来自 `settings.lighting.torch`（持久化）
 * - 启停由 `viewSettings.torch.active` 控制（不入库）
 * - **位置（跟手关键）**：
 *   - 每帧 `screenToWorld(clientX, clientY, exploreDistance)` → 世界位置
 *   - 鼠标移动同帧光源立即同步，**0 readback、0 GPU 抖动**
 * - **effectiveRange 联动**（避免「靠近相机反而黑」的反直觉）：
 *   - 光源在「视线上 exploreDistance 处」，到相机的距离 ≈ exploreDistance
 *   - PointLight 的有效作用半径 = `cfg.range + max(0, exploreDistance)`
 *   - 这样无论 exploreDistance 大小，「相机 → 光源」整条视线段都在球内
 *   - UI 上 `Range` 语义 = 「光源前方再往前能照多远」
 */
const TORCH_ENTITY_NAME = 'torchLight';

const _tmpForward = new Vec3();
const _tmpCamPos = new Vec3();
const _tmpFallbackPos = new Vec3();
const _tmpWorld = new Vec3();

type TorchControllerHandle = {
    setActive(active: boolean): void;
    refreshParamsFromSettings(): void;
    destroy(): void;
    readonly entity: Entity;
};

type TorchRuntimeState = {
    lastClientX: number | null;
    lastClientY: number | null;
};

/**
 * 初始化全局手电筒；同一 Global 重复调用返回已存在的 handle。
 */
export function initTorchLight(global: Global): TorchControllerHandle {
    const anyGlobal = global as unknown as { __torchLight?: TorchControllerHandle };
    if (anyGlobal.__torchLight) return anyGlobal.__torchLight;

    const { app, events } = global;
    const settings = global.settings as ExperienceSettings;
    ensureTorchLight(settings);
    ensureViewSettings(global);

    // 单例容器 + 子实体
    let container = app.root.findByName(TORCH_ENTITY_NAME) as Entity | null;
    if (!container) {
        container = new Entity(TORCH_ENTITY_NAME);
        app.root.addChild(container);
    }
    let entity = container.findByName('torchLight_light') as Entity | null;
    if (!entity) {
        entity = new Entity('torchLight_light');
        entity.addComponent('light', {
            type: 'point',
            color: new Color(1, 1, 1),
            intensity: 0,
            range: 1,
            castShadows: false
        });
        entity.tags.add('torchLight');
        container.addChild(entity);
    }

    const runtime: TorchRuntimeState = {
        lastClientX: null,
        lastClientY: null
    };

    /**
     * 把 settings.lighting.torch 的「颜色 / 强度」写到光组件上。
     * `range` 由 `onUpdate` 每帧根据 `cfg.range + cfg.exploreDistance` 计算并写入。
     */
    const applyParamsToEntity = () => {
        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        if (!entity?.light) return;
        const [r, g, b] = cfg.color;
        entity.light.color.set(r, g, b);
        const lowLevel = (entity.light as unknown as { light?: { setColor?: (r: number, g: number, b: number) => void } }).light;
        lowLevel?.setColor?.(r, g, b);
        entity.light.intensity = Math.max(0, Number.isFinite(cfg.intensity) ? cfg.intensity : 0);
    };

    /** 由 viewSettings.torch.active + 导出锁决定实体是否启用 */
    const shouldBeEnabled = (): boolean => {
        const stateAny = global.state as unknown as { isExportingVfxVideo?: boolean };
        if (stateAny.isExportingVfxVideo) return false;
        return ensureViewSettings(global).torch?.active === true;
    };

    /**
     * 把 client(x,y) + 距离投影到世界空间。
     * - 使用 `CameraComponent.screenToWorld`，默认采用 `canvas.clientWidth/Height`（CSS 像素）
     * - `cameraz` 是沿相机 forward 的 view-space Z（不是欧氏距离），与 `exploreDistance` 语义一致
     */
    const computeWorldOnRay = (clientX: number, clientY: number, distance: number): Vec3 | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3 } }).camera;
        if (!camComp?.screenToWorld) return null;
        camComp.screenToWorld(sx, sy, distance, _tmpWorld);
        if (!Number.isFinite(_tmpWorld.x) || !Number.isFinite(_tmpWorld.y) || !Number.isFinite(_tmpWorld.z)) return null;
        return _tmpWorld;
    };

    const onPointerMove = (event: PointerEvent) => {
        runtime.lastClientX = event.clientX;
        runtime.lastClientY = event.clientY;
    };

    const canvas = (app.graphicsDevice.canvas as HTMLCanvasElement);
    canvas.addEventListener('pointermove', onPointerMove);

    /**
     * 每帧：
     *  1. 计算 enabled，切换 cursor 与 light.enabled
     *  2. 写 effectiveRange = cfg.range + exploreDistance
     *  3. 把 PointLight 放在「鼠标视线上 exploreDistance 处」
     */
    let lastEnabledState = false;
    const onUpdate = () => {
        if (!entity?.light) return;
        const enabled = shouldBeEnabled();

        if (enabled !== lastEnabledState) {
            setTorchCursorActive(global, enabled);
            lastEnabledState = enabled;
        }

        if (!enabled) {
            entity.light.enabled = false;
            return;
        }

        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        const distance = cfg.exploreDistance ?? 5;
        const userRange = Math.max(0, cfg.range ?? 12);
        const effectiveRange = userRange + Math.max(0, distance);
        (entity.light as unknown as { range: number }).range = effectiveRange;

        let pos: Vec3 | null = null;
        if (runtime.lastClientX !== null && runtime.lastClientY !== null) {
            pos = computeWorldOnRay(runtime.lastClientX, runtime.lastClientY, distance);
        }

        // 兜底：未发生过 pointermove → 沿相机 forward 放置
        if (!pos) {
            const cam = global.camera;
            const camPos = _tmpCamPos.copy(cam.getPosition());
            const fwd = (cam as unknown as { forward: Vec3 }).forward;
            _tmpForward.set(fwd.x, fwd.y, fwd.z);
            const fl = _tmpForward.length();
            if (fl > 1e-6) {
                _tmpForward.mulScalar(1 / fl);
                _tmpFallbackPos.set(
                    camPos.x + _tmpForward.x * distance,
                    camPos.y + _tmpForward.y * distance,
                    camPos.z + _tmpForward.z * distance
                );
                pos = _tmpFallbackPos;
            }
        }
        if (!pos) {
            entity.light.enabled = false;
            return;
        }

        entity.setPosition(pos.x, pos.y, pos.z);
        entity.light.enabled = true;
    };
    app.on('update', onUpdate);

    /** 参数变更（settings.lighting.torch 被改时）即时刷新到实体 */
    const onTorchParamsChanged = () => {
        applyParamsToEntity();
    };
    events.on('torchParams:changed', onTorchParamsChanged);

    const handle: TorchControllerHandle = {
        get entity() {
            return entity as Entity;
        },
        setActive(active: boolean) {
            const vs = ensureViewSettings(global);
            if (!vs.torch) vs.torch = { active: false };
            vs.torch.active = !!active;
            onUpdate();
        },
        refreshParamsFromSettings() {
            applyParamsToEntity();
        },
        destroy() {
            try {
                canvas.removeEventListener('pointermove', onPointerMove);
            } catch { /* ignore */ }
            app.off('update', onUpdate);
            events.off('torchParams:changed', onTorchParamsChanged);
            setTorchCursorActive(global, false);
            try {
                if (container) (container as Entity).destroy();
            } catch { /* ignore */ }
            delete (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
        }
    };

    (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight = handle;
    applyParamsToEntity();
    onUpdate();
    return handle;
}

/** 读取（懒）当前手电筒实体；未初始化时返回 null */
export function getTorchLightEntity(global: Global): Entity | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    return handle?.entity ?? null;
}

/** 读取手电筒是否正在 enable */
export function isTorchEntityEnabled(global: Global): boolean {
    const e = getTorchLightEntity(global);
    return !!(e && e.light && e.light.enabled);
}
