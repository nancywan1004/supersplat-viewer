import {
    normalizeSceneAssetCollisionScale,
    patchSceneAssetCollisionRuntimeState,
    readSceneAssetCollisionRuntimeState,
    syncSceneAssetCollisionRuntime,
    type SceneAssetCollisionAxisScale
} from '../../scene-assets/collision/scene-asset-collision';
import { getSceneAssetCollisionDebugVisual } from '../../scene-assets/collision/scene-asset-collision-debug';
import {
    collisionActive,
    collisionEnabled,
    getCameraCollisionManager
} from '../../collision/camera-collision-manager';
import { applyCollisionSetFromHost } from '../../editor-modules/protocol-adapters/collision-protocol-adapter';
import { pushEditHistory } from '../../edit-history';
import {
    MOVE_SPEED_SCALE_UI_MAX,
    MOVE_SPEED_SCALE_UI_MIN,
    MOVE_SPEED_SCALE_UI_STEP,
    parseMoveSpeedScale,
    readMoveSpeedScale,
    writeMoveSpeedScale
} from '../../input/move-speed-scale';
import type { ExperienceSettings } from '../../schemas/v2';
import type { Global } from '../../types';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

export function syncSceneAssetCollisionFromState(global: Global): void {
    syncSceneAssetCollisionRuntime(global);
}

export function getCameraSettingsHTML(): string {
    return `
<div class="camera-panel-section" data-camera-settings-root>
    <div class="settingsRow submenuHeader camera-settings-header expanded" id="cameraMoveSpeedHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="cameraMoveSpeedArrow">▶</span>
        <span>移动步长</span>
    </div>
    <div id="cameraMoveSpeedSubpanel" class="subpanel">
        <div class="settingsRow camera-settings-hint">
            乘在场景尺寸自适应速度之上，默认 1。大场景小步可调到 0.1～0.5。
        </div>
        <div class="settingsRow">
            <label for="cameraMoveSpeedScale">系数</label>
            <input type="range" id="cameraMoveSpeedScale" min="${MOVE_SPEED_SCALE_UI_MIN}" max="${MOVE_SPEED_SCALE_UI_MAX}" step="${MOVE_SPEED_SCALE_UI_STEP}" />
            <span id="cameraMoveSpeedScaleVal" class="settingsValueLabel"></span>
        </div>
    </div>
    <div class="settingsRow submenuHeader camera-settings-header expanded" id="cameraSettingsHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="cameraSettingsArrow">▶</span>
        <span>物理碰撞</span>
    </div>
    <div id="cameraSettingsSubpanel" class="subpanel">
        <div class="settingsRow camera-settings-hint" id="cameraCollisionHint">
            统一控制场景 collision 网格（Walk/Fly 贴地推开）与放置资产 AABB（Fly/Orbit）；仅 Viewer 或编辑预览生效。场景网格调试线框见顶栏「Show Collision」。
        </div>
        <div class="settingsRow">
            <label for="cameraCollisionEnabled">启用物理碰撞</label>
            <input type="checkbox" id="cameraCollisionEnabled" />
        </div>
        <div class="settingsRow">
            <label for="sceneAssetCollisionDebugVisual">显示放置资产碰撞 AABB 线框</label>
            <input type="checkbox" id="sceneAssetCollisionDebugVisual" />
        </div>
        <div id="sceneAssetCollisionScalePanel">
            <div class="settingsRow">
                <label for="sceneAssetCollisionAutoFit">各向自动贴合</label>
                <input type="checkbox" id="sceneAssetCollisionAutoFit" />
            </div>
            <div class="settingsRow camera-settings-subhint" id="sceneAssetCollisionAutoFitHint">
                开启后按模型自动收紧碰撞盒，无需调节 XYZ；关闭后可手动缩放各轴。
            </div>
            <div id="sceneAssetCollisionManualScalePanel">
            <div class="settingsRow camera-settings-axis-group">
                <span class="camera-settings-axis-label">高斯 XYZ</span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionGaussianScaleX">X</label>
                <input type="range" id="sceneAssetCollisionGaussianScaleX" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionGaussianValX" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionGaussianScaleY">Y</label>
                <input type="range" id="sceneAssetCollisionGaussianScaleY" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionGaussianValY" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionGaussianScaleZ">Z</label>
                <input type="range" id="sceneAssetCollisionGaussianScaleZ" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionGaussianValZ" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow camera-settings-axis-group">
                <span class="camera-settings-axis-label">Mesh XYZ</span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionMeshScaleX">X</label>
                <input type="range" id="sceneAssetCollisionMeshScaleX" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionMeshValX" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionMeshScaleY">Y</label>
                <input type="range" id="sceneAssetCollisionMeshScaleY" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionMeshValY" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="sceneAssetCollisionMeshScaleZ">Z</label>
                <input type="range" id="sceneAssetCollisionMeshScaleZ" min="50" max="150" step="1" />
                <span id="sceneAssetCollisionMeshValZ" class="settingsValueLabel"></span>
            </div>
            </div>
        </div>
    </div>
</div>
`.trim();
}

type AxisBinding = {
    input: HTMLInputElement | null;
    label: HTMLSpanElement | null;
    axis: 'x' | 'y' | 'z';
};

export function bindCameraSettings(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const { events } = global;
    const editUiTransport = getEditUiTransport(global);
    syncSceneAssetCollisionFromState(global);

    const onPanelWheel = (event: WheelEvent) => {
        event.stopPropagation();
    };
    root.addEventListener('wheel', onPanelWheel);
    const readRs = () => readSceneAssetCollisionRuntimeState(global);
    const collisionMgr = () => getCameraCollisionManager(global);

    const enabledInput = root.querySelector<HTMLInputElement>('#cameraCollisionEnabled');
    const debugVisualInput = root.querySelector<HTMLInputElement>('#sceneAssetCollisionDebugVisual');
    const autoFitInput = root.querySelector<HTMLInputElement>('#sceneAssetCollisionAutoFit');
    const hintEl = root.querySelector<HTMLElement>('#cameraCollisionHint');
    const scalePanel = root.querySelector<HTMLElement>('#sceneAssetCollisionScalePanel');
    const manualScalePanel = root.querySelector<HTMLElement>('#sceneAssetCollisionManualScalePanel');
    const moveSpeedSlider = root.querySelector<HTMLInputElement>('#cameraMoveSpeedScale');
    const moveSpeedValue = root.querySelector<HTMLElement>('#cameraMoveSpeedScaleVal');

    const gaussianBindings: AxisBinding[] = [
        { input: root.querySelector('#sceneAssetCollisionGaussianScaleX'), label: root.querySelector('#sceneAssetCollisionGaussianValX'), axis: 'x' },
        { input: root.querySelector('#sceneAssetCollisionGaussianScaleY'), label: root.querySelector('#sceneAssetCollisionGaussianValY'), axis: 'y' },
        { input: root.querySelector('#sceneAssetCollisionGaussianScaleZ'), label: root.querySelector('#sceneAssetCollisionGaussianValZ'), axis: 'z' }
    ];
    const meshBindings: AxisBinding[] = [
        { input: root.querySelector('#sceneAssetCollisionMeshScaleX'), label: root.querySelector('#sceneAssetCollisionMeshValX'), axis: 'x' },
        { input: root.querySelector('#sceneAssetCollisionMeshScaleY'), label: root.querySelector('#sceneAssetCollisionMeshValY'), axis: 'y' },
        { input: root.querySelector('#sceneAssetCollisionMeshScaleZ'), label: root.querySelector('#sceneAssetCollisionMeshValZ'), axis: 'z' }
    ];

    const syncAxisUi = (bindings: AxisBinding[], axis: SceneAssetCollisionAxisScale) => {
        const pct = {
            x: Math.round(axis.x * 100),
            y: Math.round(axis.y * 100),
            z: Math.round(axis.z * 100)
        };
        for (const b of bindings) {
            const v = pct[b.axis];
            if (b.input) b.input.value = String(v);
            if (b.label) b.label.textContent = `${v}%`;
        }
    };

    const updateManualScalePanelVisibility = (autoFit: boolean) => {
        if (manualScalePanel) {
            manualScalePanel.classList.toggle('hidden', autoFit);
        }
    };

    const syncScaleUi = () => {
        const rs = readRs();
        const autoFit = !!rs.scale.autoFit;
        syncAxisUi(gaussianBindings, rs.scale.gaussian);
        syncAxisUi(meshBindings, rs.scale.mesh);
        if (autoFitInput) autoFitInput.checked = autoFit;
        updateManualScalePanelVisibility(autoFit);
    };

    const updateActiveHint = () => {
        if (!hintEl) return;
        const enabled = collisionEnabled(global);
        if (enabledInput) {
            enabledInput.checked = enabled;
        }
        const hasSceneMeshUrl = global.state.hasCollision;
        const urlLoadState = collisionMgr().getLoadState();
        const base =
            '统一控制场景 collision 网格（Walk/Fly 贴地推开）与放置资产 AABB（Fly/Orbit）；仅 Viewer 或编辑预览生效。'
            + (hasSceneMeshUrl ? ' 场景网格调试线框见顶栏「Show Collision」。' : '');
        if (!enabled) {
            hintEl.textContent = base;
            return;
        }
        const active = collisionActive(global);
        const parts: string[] = [];
        if (active) {
            parts.push('当前已启用物理碰撞。');
            if (hasSceneMeshUrl) {
                if (urlLoadState === 'loading') {
                    parts.push(
                        collisionMgr().getCollisionUrl()
                            ? '场景网格加载中…'
                            : '正在向 Universe 生成场景碰撞网格…'
                    );
                } else if (urlLoadState === 'ready') {
                    parts.push('场景网格已参与 Walk/Fly。');
                } else if (urlLoadState === 'failed') {
                    parts.push('场景网格加载失败。');
                } else {
                    parts.push('场景网格将在需要时加载。');
                }
            }
            if (enabled && collisionActive(global)) {
                parts.push('放置资产 AABB 已参与 Fly/Orbit。');
            }
        } else {
            parts.push('已开启开关，进入 Viewer 或预览模式后生效。');
        }
        hintEl.textContent = `${base} ${parts.join('')}`;
    };

    const readAxisFromBindings = (bindings: AxisBinding[]): SceneAssetCollisionAxisScale => {
        const axis: SceneAssetCollisionAxisScale = { x: 1, y: 1, z: 1 };
        for (const b of bindings) {
            if (b.input) {
                axis[b.axis] = Number(b.input.value) / 100;
            }
        }
        return axis;
    };

    const applyScaleFromInputs = () => {
        const prev = readRs();
        if (prev.scale.autoFit) {
            return;
        }
        patchSceneAssetCollisionRuntimeState(global, {
            scale: normalizeSceneAssetCollisionScale({
                gaussian: readAxisFromBindings(gaussianBindings),
                mesh: readAxisFromBindings(meshBindings),
                autoFit: false
            })
        });
        syncSceneAssetCollisionRuntime(global);
        syncScaleUi();
        updateActiveHint();
        events.fire('sceneAssetCollision:changed');
    };

    let onDebugVisualChange: (() => void) | null = null;
    if (debugVisualInput) {
        debugVisualInput.checked = readRs().debugVisual;
        onDebugVisualChange = () => {
            patchSceneAssetCollisionRuntimeState(global, { debugVisual: debugVisualInput.checked });
            getSceneAssetCollisionDebugVisual(global).setVisible(debugVisualInput.checked);
            events.fire('sceneAssetCollisionDebugVisual:changed', debugVisualInput.checked);
        };
        debugVisualInput.addEventListener('change', onDebugVisualChange);
    }

    let onAutoFitChange: (() => void) | null = null;
    if (autoFitInput) {
        onAutoFitChange = () => {
            const rs = readRs();
            patchSceneAssetCollisionRuntimeState(global, {
                scale: normalizeSceneAssetCollisionScale({
                    ...rs.scale,
                    autoFit: autoFitInput.checked
                })
            });
            syncSceneAssetCollisionRuntime(global);
            syncScaleUi();
            updateActiveHint();
            events.fire('sceneAssetCollision:changed');
        };
        autoFitInput.addEventListener('change', onAutoFitChange);
    }

    let onEnabledChange: (() => void) | null = null;
    if (enabledInput) {
        enabledInput.checked = collisionEnabled(global);
        onEnabledChange = () => {
            const enabled = enabledInput.checked;
            void applyCollisionSetFromHost(global, enabled).finally(() => {
                enabledInput.checked = collisionEnabled(global);
                if (scalePanel) {
                    scalePanel.classList.toggle('hidden', !enabledInput.checked);
                }
                updateActiveHint();
            });
        };
        enabledInput.addEventListener('change', onEnabledChange);
        if (scalePanel) {
            scalePanel.classList.toggle('hidden', !collisionEnabled(global));
        }
    }

    const formatMoveSpeedScale = (scale: number) => scale.toFixed(2);

    const syncMoveSpeedScaleUi = (scale = readMoveSpeedScale(global.settings as ExperienceSettings)) => {
        const sliderValue = Math.min(
            MOVE_SPEED_SCALE_UI_MAX,
            Math.max(MOVE_SPEED_SCALE_UI_MIN, scale)
        );
        if (moveSpeedSlider) {
            moveSpeedSlider.value = String(sliderValue);
        }
        if (moveSpeedValue) {
            moveSpeedValue.textContent = formatMoveSpeedScale(scale);
        }
    };

    const applyMoveSpeedScale = (raw: number, commitHistory: boolean) => {
        const scale = parseMoveSpeedScale(raw);
        if (scale == null) {
            return;
        }
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'CAMERA_MOVE_SPEED_SCALE_SET', value: scale });
            return;
        }
        writeMoveSpeedScale(global.settings as ExperienceSettings, scale);
        events.fire('camera:moveSpeedScaleChanged', scale);
        if (commitHistory) {
            pushEditHistory(global, 'move speed scale');
        }
    };

    const onMoveSpeedInput = () => {
        if (!moveSpeedSlider) {
            return;
        }
        const scale = Number(moveSpeedSlider.value);
        if (moveSpeedValue) {
            moveSpeedValue.textContent = formatMoveSpeedScale(scale);
        }
        applyMoveSpeedScale(scale, false);
    };
    const onMoveSpeedChange = () => {
        if (!moveSpeedSlider) {
            return;
        }
        applyMoveSpeedScale(Number(moveSpeedSlider.value), true);
    };
    const onMoveSpeedScaleChanged = (scale: number) => {
        syncMoveSpeedScaleUi(parseMoveSpeedScale(scale) ?? readMoveSpeedScale(global.settings as ExperienceSettings));
    };
    const onSettingsSnapshotApplied = () => {
        syncMoveSpeedScaleUi();
    };

    syncMoveSpeedScaleUi();
    moveSpeedSlider?.addEventListener('input', onMoveSpeedInput);
    moveSpeedSlider?.addEventListener('change', onMoveSpeedChange);
    events.on('camera:moveSpeedScaleChanged', onMoveSpeedScaleChanged);
    events.on('settingsSnapshotApplied', onSettingsSnapshotApplied);

    getSceneAssetCollisionDebugVisual(global).setVisible(readRs().debugVisual);

    syncScaleUi();
    updateActiveHint();

    const axisListeners: Array<{ el: HTMLInputElement; fn: () => void }> = [];
    const bindAxisInput = (bindings: AxisBinding[]) => {
        for (const b of bindings) {
            if (!b.input) continue;
            const fn = () => applyScaleFromInputs();
            b.input.addEventListener('input', fn);
            axisListeners.push({ el: b.input, fn });
        }
    };
    bindAxisInput(gaussianBindings);
    bindAxisInput(meshBindings);

    const onModeChanged = () => updateActiveHint();
    events.on('editMode:changed', onModeChanged);
    events.on('previewMode:changed', onModeChanged);
    events.on('cameraCollision:changed', onModeChanged);
    events.on('cameraCollision:load', onModeChanged);

    return () => {
        if (debugVisualInput && onDebugVisualChange) {
            debugVisualInput.removeEventListener('change', onDebugVisualChange);
        }
        if (autoFitInput && onAutoFitChange) {
            autoFitInput.removeEventListener('change', onAutoFitChange);
        }
        if (enabledInput && onEnabledChange) {
            enabledInput.removeEventListener('change', onEnabledChange);
        }
        for (const { el, fn } of axisListeners) {
            el.removeEventListener('input', fn);
        }
        moveSpeedSlider?.removeEventListener('input', onMoveSpeedInput);
        moveSpeedSlider?.removeEventListener('change', onMoveSpeedChange);
        events.off('camera:moveSpeedScaleChanged', onMoveSpeedScaleChanged);
        events.off('settingsSnapshotApplied', onSettingsSnapshotApplied);
        root.removeEventListener('wheel', onPanelWheel);
        events.off('editMode:changed', onModeChanged);
        events.off('previewMode:changed', onModeChanged);
        events.off('cameraCollision:changed', onModeChanged);
        events.off('cameraCollision:load', onModeChanged);
    };
}
