import {
    getSceneAssetCollisionRuntime,
    isSceneAssetCollisionRuntimeActive,
    normalizeSceneAssetCollisionScale,
    patchSceneAssetCollisionRuntimeState,
    readSceneAssetCollisionRuntimeState,
    syncSceneAssetCollisionRuntime,
    type SceneAssetCollisionAxisScale
} from '../../scene-assets/collision/scene-asset-collision';
import { getSceneAssetCollisionDebugVisual } from '../../scene-assets/collision/scene-asset-collision-debug';
import type { Global } from '../../types';

export function syncSceneAssetCollisionFromState(global: Global): void {
    syncSceneAssetCollisionRuntime(global);
}

export function getCameraSettingsHTML(): string {
    return `
<div class="camera-panel-section" data-camera-settings-root>
    <div class="settingsRow submenuHeader camera-settings-header expanded" id="cameraSettingsHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="cameraSettingsArrow">▶</span>
        <span>物理碰撞</span>
    </div>
    <div id="cameraSettingsSubpanel" class="subpanel">
        <div class="settingsRow camera-settings-hint" id="sceneAssetCollisionHint">
            对所有可见 mesh/gaussian 放置项生效；Fly / Orbit 推开，仅 Viewer 或编辑预览阻挡相机。线框显示全部碰撞盒。
        </div>
        <div class="settingsRow">
            <label for="sceneAssetCollisionEnabled">放置资产包围盒碰撞</label>
            <input type="checkbox" id="sceneAssetCollisionEnabled" />
        </div>
        <div class="settingsRow">
            <label for="sceneAssetCollisionDebugVisual">显示碰撞 AABB 线框</label>
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
    syncSceneAssetCollisionFromState(global);
    const readRs = () => readSceneAssetCollisionRuntimeState(global);

    const enabledInput = root.querySelector<HTMLInputElement>('#sceneAssetCollisionEnabled');
    const debugVisualInput = root.querySelector<HTMLInputElement>('#sceneAssetCollisionDebugVisual');
    const autoFitInput = root.querySelector<HTMLInputElement>('#sceneAssetCollisionAutoFit');
    const hintEl = root.querySelector<HTMLElement>('#sceneAssetCollisionHint');
    const scalePanel = root.querySelector<HTMLElement>('#sceneAssetCollisionScalePanel');
    const manualScalePanel = root.querySelector<HTMLElement>('#sceneAssetCollisionManualScalePanel');

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
        const rs = readRs();
        const active = isSceneAssetCollisionRuntimeActive(global, rs.enabled);
        const base = '对所有可见 mesh/gaussian 放置项生效；Fly / Orbit 推开，仅 Viewer 或编辑预览阻挡相机。线框显示全部碰撞盒。';
        if (!rs.enabled) {
            hintEl.textContent = base;
            return;
        }
        hintEl.textContent = active
            ? `${base} 当前已启用碰撞推开。`
            : `${base} 已开启开关，进入 Viewer 或预览模式后生效。`;
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
        enabledInput.checked = readRs().enabled;
        onEnabledChange = () => {
            patchSceneAssetCollisionRuntimeState(global, { enabled: enabledInput.checked });
            syncSceneAssetCollisionRuntime(global);
            if (scalePanel) {
                scalePanel.classList.toggle('hidden', !enabledInput.checked);
            }
            updateActiveHint();
            events.fire('sceneAssetCollision:changed');
        };
        enabledInput.addEventListener('change', onEnabledChange);
        if (scalePanel) {
            scalePanel.classList.toggle('hidden', !readRs().enabled);
        }
    }

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
        events.off('editMode:changed', onModeChanged);
        events.off('previewMode:changed', onModeChanged);
    };
}
