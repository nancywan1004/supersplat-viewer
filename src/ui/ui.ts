import { EventHandler } from 'playcanvas';

import { SCENE_COLLISION_CHANGED } from '../collision/scene-collision-source';
import {
    initEditHistory,
    canUndo,
    canRedo,
    undo,
    redo,
    restoreAnnotationsFromSettings,
    restoreLightingFromSettings,
    restorePostEffectsFromSettings,
    mergeSkyboxOnEditEnter,
    applySkyboxOnEditEnter,
    restoreSkyboxFromSettings
} from '../edit-history';
import { dispatchEffectsModuleCommand } from '../editor-modules/effects-facade';
import { applyEnvironmentPreviewVisualPolicy } from '../editor-modules/environment-facade';
import { applyLightToggle } from '../editor-modules/protocol-adapters/environment-protocol-adapter';
import {
    createViewportSettleScheduler,
    shouldUseTouchJoystickMove
} from '../input/touch-joystick-ui';
import { isCustomLodEnabled } from '../loaders/gsplat/lod/custom-loader';
import type { ExperienceSettings } from '../schemas/v2';
import { Tooltip } from '../tooltip';
import { Global, type State } from '../types';
import {
    serializeExperienceSettings,
    getComparableSettingsString,
    getComparableSettingsStringFromSnapshot,
    applySettingsSnapshot,
    syncEditBaselineCollisionFromGlobal,
    logSettingsDiffDetails
} from '../settings-serialize/settings-serialize';
import { readSkyboxCurrentUrlFromSettings } from '../settings-serialize/settings-serialize-helper';
import { saveExperienceProject, type SettingsSaveDestination } from '../settings-io/save';
import { importLocalProject } from '../settings-io/import-local-project';
import { resetSceneSettings } from '../settings-reset';
import {
    applyMorphKeyframeVisibilityPolicy,
    requestSceneAssetsRestore
} from '../scene-assets/asset-placement-handler';
import { applyViewMediaMuteSet, applyViewTorchActive, readViewTorchActive } from '../view-settings';
import { initAnnotationUI } from './components/annotation-ui';
import { initAssetEffectsUI } from './components/asset-effects-ui';
import { showEditToast } from './components/edit-toast-ui';
import { initRevealUI } from './components/effects-ui';
import { showExitEditConfirmModal } from './components/exit-edit-confirm-ui';
import { confirmSceneReset } from './components/settings-reset-confirm-ui';
import { initVideoExportUI } from './components/video-export-ui';
import { initLightingUI } from './components/lighting-ui';
import { initPostEffectUI } from './components/environment-ui';
import { initViewSceneContentDebugUI } from './components/view-scene-content-debug-ui';
import { initEditBottomToolbarUI } from './edit-bottom-toolbar';
import { initEditLeftToolbarUI } from './edit-left-toolbar';
import { initEditRightToolbarUI } from './edit-right-toolbar';
import type { Annotation } from '../settings';
import { getEditUiTransport, sendEditProtocolMessage } from './edit-ui-transport';
import { getRevealActiveType, readRevealParams } from '../settings-serialize/effects-sync';
import { revealBlocksAnim } from '../vfx/effects-runtime/reveal/reveal-policy';

/** zip / OSS 附件可能需拉文件，避免 3s 误失败 */
const SETTINGS_SAVE_RESULT_TIMEOUT_MS = 60_000;

function waitForSettingsSaveResult(timeoutMs = SETTINGS_SAVE_RESULT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
        let to = 0;
        const onMsg = (ev: MessageEvent) => {
            const data = ev.data as {
                type?: string;
                ok?: boolean;
                message?: string;
                payload?: { message?: string; ok?: boolean }
            };
            if (!data) return;
            if (
                data.type !== 'SETTINGS_UPDATED' &&
                data.type !== 'SETTINGS_SAVE_FAILED' &&
                data.type !== 'SETTINGS_SAVE_RESULT'
            ) {
                return;
            }
            window.removeEventListener('message', onMsg);
            clearTimeout(to);
            if (data.type === 'SETTINGS_SAVE_FAILED') {
                const failMsg =
                    (typeof data.message === 'string' && data.message) ||
                    data.payload?.message ||
                    'SETTINGS_SAVE_FAILED';
                reject(new Error(failMsg));
                return;
            }
            if (data.type === 'SETTINGS_SAVE_RESULT' && data.ok === false) {
                const failMsg =
                    (typeof data.message === 'string' && data.message) ||
                    data.payload?.message ||
                    'SETTINGS_SAVE_RESULT';
                reject(new Error(failMsg));
                return;
            }
            resolve();
        };
        to = window.setTimeout(() => {
            window.removeEventListener('message', onMsg);
            reject(new Error('timeout waiting for SETTINGS_UPDATED / SETTINGS_SAVE_RESULT / SETTINGS_SAVE_FAILED'));
        }, timeoutMs);
        window.addEventListener('message', onMsg);
    });
}

// Initialize the touch joystick for fly mode camera control
const initJoystick = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: Pick<State, 'cameraMode' | 'inputMode' | 'gamingControls' | 'hasRevealEffect' | 'effectsRuntimeState'>,
    settings: ExperienceSettings
) => {
    if (!dom.joystickBase || !dom.joystick || !dom.joystickLookBase || !dom.joystickLook) {
        console.warn('[Joystick] missing joystick dom nodes, skip init');
        return;
    }

    // Joystick dimensions (matches SCSS)
    const joystickHeight = 112;
    const stickSize = 44;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 30px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 30px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 30px up or down from center

    // Fixed positions (bottom corners with safe area)
    const joystickLeft = 84;
    const lookJoystickLeft = () => {
        const width = Math.max(window.innerWidth, document.documentElement.clientWidth || 0);
        return width - 84;
    };
    const joystickBottom = 'calc(env(safe-area-inset-bottom, 0px) + 48px)';

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = up/forward on the UI, positive = down/backward
    let joystickLookPointerId: number | null = null;
    let joystickLookValueX = 0; // -1 to 1, negative = look left, positive = look right
    let joystickLookValueY = 0; // -1 to 1, negative = look up, positive = look down

    const getElementCenter = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width * 0.5,
            y: rect.top + rect.height * 0.5
        };
    };

    // 仅在「会真正播放的一次性 reveal」期间藏摇杆；autoStart:false / completed / persistent 不挡。
    let revealReady = !revealBlocksAnim(state, readRevealParams(settings));

    // Joystick: touch + landscape only (portrait uses two-finger fly)
    const updateJoystickVisibility = () => {
        const joystickEnabled = revealReady && shouldUseTouchJoystickMove(state);
        if (joystickEnabled) {
            dom.joystickBase.classList.remove('hidden');
            dom.joystickLookBase.classList.remove('hidden');
            dom.joystickBase.classList.add('mode-2d');
            dom.joystickLookBase.classList.add('mode-2d');
            dom.joystickBase.style.left = `${joystickLeft}px`;
            dom.joystickBase.style.right = '';
            dom.joystickBase.style.top = '';
            dom.joystickBase.style.bottom = joystickBottom;
            dom.joystickLookBase.style.left = `${lookJoystickLeft()}px`;
            dom.joystickLookBase.style.right = '';
            dom.joystickLookBase.style.top = '';
            dom.joystickLookBase.style.bottom = joystickBottom;
            dom.joystick.style.top = `${stickCenterY}px`;
            dom.joystickLook.style.top = `${stickCenterY}px`;
            dom.joystick.style.left = `${stickCenterX}px`;
            dom.joystickLook.style.left = `${stickCenterX}px`;
        } else {
            dom.joystickBase.classList.add('hidden');
            dom.joystickLookBase.classList.add('hidden');
            events.fire('joystickInput', { x: 0, y: 0 });
            events.fire('joystickLookInput', { x: 0, y: 0 });
        }
        events.fire('touchJoystickUi', {
            active: joystickEnabled
        });
    };

    const syncRevealReady = () => {
        revealReady = !revealBlocksAnim(state, readRevealParams(settings));
        updateJoystickVisibility();
    };

    // 旋转时事件早于宽高交换：等到视口连续两帧尺寸不变再判，不用写死延迟。
    const joystickViewportSettle = createViewportSettleScheduler({
        onUpdate: updateJoystickVisibility
    });

    events.on('cameraMode:changed', updateJoystickVisibility);
    events.on('inputMode:changed', updateJoystickVisibility);
    events.on('gamingControls:changed', updateJoystickVisibility);
    events.on('hasRevealEffect:changed', () => {
        queueMicrotask(syncRevealReady);
    });
    events.on('revealComplete', () => {
        queueMicrotask(syncRevealReady);
    });
    events.on('revealRestart', () => {
        queueMicrotask(syncRevealReady);
    });
    window.addEventListener('resize', joystickViewportSettle.schedule);
    window.addEventListener('orientationchange', joystickViewportSettle.schedule);
    window.visualViewport?.addEventListener('resize', joystickViewportSettle.schedule);
    window.matchMedia('(orientation: landscape)').addEventListener('change', joystickViewportSettle.schedule);
    screen?.orientation?.addEventListener('change', joystickViewportSettle.schedule);
    updateJoystickVisibility();

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        const center = getElementCenter(dom.joystickBase);
        const baseY = center.y;
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        const baseX = center.x;
        const offsetX = clientX - baseX;
        const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
        joystickValueX = clampedOffsetX / maxStickTravel;

        // Update stick visual X position
        dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;

        // Fire input event for the input controller
        events.fire('joystickInput', { x: joystickValueX, y: joystickValueY });
    };

    const updateLookJoystickStick = (clientX: number, clientY: number) => {
        const center = getElementCenter(dom.joystickLookBase);
        const baseX = center.x;
        const baseY = center.y;
        const offsetX = clientX - baseX;
        const offsetY = clientY - baseY;
        const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickLookValueX = clampedOffsetX / maxStickTravel;
        joystickLookValueY = clampedOffsetY / maxStickTravel;

        dom.joystickLook.style.left = `${stickCenterX + clampedOffsetX}px`;
        dom.joystickLook.style.top = `${stickCenterY + clampedOffsetY}px`;
        events.fire('joystickLookInput', { x: joystickLookValueX, y: joystickLookValueY });
    };

    dom.joystickBase.addEventListener('pointerdown', (event: PointerEvent) => {
        if (joystickPointerId !== null) return; // Already tracking a touch

        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    });

    dom.joystickBase.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    });

    const endJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        joystickPointerId = null;
        joystickValueX = 0;
        joystickValueY = 0;

        // Reset stick to center
        dom.joystick.style.top = `${stickCenterY}px`;
        dom.joystick.style.left = `${stickCenterX}px`;

        // Fire input event with zero values
        events.fire('joystickInput', { x: 0, y: 0 });

        dom.joystickBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);

    dom.joystickLookBase.addEventListener('pointerdown', (event: PointerEvent) => {
        if (joystickLookPointerId !== null) return;

        joystickLookPointerId = event.pointerId;
        dom.joystickLookBase.setPointerCapture(event.pointerId);
        updateLookJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    });

    dom.joystickLookBase.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerId !== joystickLookPointerId) return;

        updateLookJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    });

    const endLookJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickLookPointerId) return;

        joystickLookPointerId = null;
        joystickLookValueX = 0;
        joystickLookValueY = 0;
        dom.joystickLook.style.left = `${stickCenterX}px`;
        dom.joystickLook.style.top = `${stickCenterY}px`;
        events.fire('joystickLookInput', { x: 0, y: 0 });
        dom.joystickLookBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickLookBase.addEventListener('pointerup', endLookJoystickTouch);
    dom.joystickLookBase.addEventListener('pointercancel', endLookJoystickTouch);
};

// Initialize the annotation navigator for stepping between annotations
const initAnnotationNav = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { loaded: boolean; inputMode: string; controlsHidden: boolean },
    annotations: Annotation[]
) => {
    // Only show navigator when there are at least 2 annotations
    if (annotations.length < 2) return;

    let currentIndex = 0;

    const updateDisplay = () => {
        dom.annotationNavTitle.textContent = annotations[currentIndex].title || '';
    };

    const updateMode = () => {
        if (!state.loaded) return;
        dom.annotationNav.classList.remove('desktop', 'touch', 'hidden');
        dom.annotationNav.classList.add(state.inputMode);
    };

    const updateFade = () => {
        if (!state.loaded) return;
        dom.annotationNav.classList.toggle('faded-in', !state.controlsHidden);
        dom.annotationNav.classList.toggle('faded-out', state.controlsHidden);
    };

    const goTo = (index: number) => {
        currentIndex = index;
        updateDisplay();
        events.fire('annotation.navigate', annotations[currentIndex]);
    };

    // Prev / Next
    dom.annotationPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        goTo((currentIndex - 1 + annotations.length) % annotations.length);
    });

    dom.annotationNext.addEventListener('click', (e) => {
        e.stopPropagation();
        goTo((currentIndex + 1) % annotations.length);
    });

    // Sync when an annotation is activated externally (e.g. hotspot click)
    events.on('annotation.activate', (annotation: Annotation) => {
        const idx = annotations.indexOf(annotation);
        if (idx !== -1) {
            currentIndex = idx;
            updateDisplay();
        }
    });

    // React to state changes
    events.on('loaded:changed', () => {
        updateMode();
        updateFade();
    });
    events.on('inputMode:changed', updateMode);
    events.on('controlsHidden:changed', updateFade);

    // Initial state
    updateDisplay();
};

// update the poster image to start blurry and then resolve to sharp during loading
const initPoster = (events: EventHandler) => {
    const poster = document.getElementById('poster');

    events.on('loaded:changed', () => {
        poster.style.display = 'none';
        document.documentElement.style.setProperty('--canvas-opacity', '1');
    });

    const blur = (progress: number) => {
        poster.style.filter = `blur(${Math.floor((100 - progress) * 0.4)}px)`;
    };

    events.on('progress:changed', blur);
};

const initUI = (global: Global) => {
    const { config, events, state, settings } = global;
    const editUiTransport = getEditUiTransport(global);

    // Acquire Elements
    const docRoot = document.documentElement;
    const dom = [
        'ui',
        'controlsWrap',
        'editModeStrip', 'editModeBtn', 'exitEditBtn', 'resetSettingsBtn', 'saveSettingsWrap', 'saveSettingsBtn', 'saveSettingsDropdown', 'undoEditBtn', 'redoEditBtn', 'rightToolBar',
        'arMode', 'vrMode',
        'enterFullscreen', 'exitFullscreen',
        'info', 'infoPanel', 'desktopTab', 'touchTab', 'desktopInfoPanel', 'touchInfoPanel',
        'timelineContainer', 'handle', 'time',
        'buttonContainer',
        'play', 'pause',
        'settings', 'settingsPanel',
        'orbitCamera', 'flyCamera', 'fpsCamera',
        'performanceModeRow', 'performanceModeCheck', 'performanceModeOption',
        'gamingControlsDivider', 'gamingControlsRow', 'gamingControlsCheck', 'gamingControlsOption',
        'desktopClickToWalk', 'desktopGamingControls',
        'touchFlyClickToWalk', 'touchFlyGamingControls',
        'touchClickToWalk', 'touchGamingControls',
        'walkHint',
        'cameraPathCheck', 'cameraPathOption',
        'cameraBoundsCheck', 'cameraBoundsOption',
        'vfxSubmenuHeader', 'vfxSubpanel', 'vfxSubmenuArrow',
        'lightingSubmenuHeader', 'lightingSubpanel', 'lightingSubmenuArrow',
        'postEffectSubmenuHeader', 'postEffectSubpanel', 'postEffectSubmenuArrow',
        'renderSubmenuHeader', 'renderSubpanel', 'renderSubmenuArrow',
        'reset', 'frame',
        'getCameraInfo',
        'loadingText', 'loadingBar', 'loadingIcon',
        'joystickBase', 'joystick',
        'joystickLookBase', 'joystickLook',
        'showCollision',
        'tooltip',
        'annotationNav', 'annotationPrev', 'annotationNext', 'annotationInfo', 'annotationNavTitle',
        // 'supersplatBranding',
        // View 模式调试按钮（右上角编辑按钮旁）
        'viewSceneContentDebugBtn',
        'viewDebugRegionSelect', 'viewDebugToggleRegionLight',
        'viewDebugMediaMute', 'viewDebugMediaUnmute',
        'viewDebugTorchToggle', 'viewDebugMorphStopAll'
    ].reduce((acc: Record<string, HTMLElement>, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, {});
    dom.previewModeBtn = document.getElementById('previewModeBtn');

    // Check if LOD mode is enabled
    const isLodMode = isCustomLodEnabled(settings, config.contentUrl);

    // In LOD mode, show progress bar but mark as 100% when animation starts
    // Progress is calculated based on threshold, reaching 100% when animation begins
    const hideProgressBarInLodMode = false;
    // Forward wheel events from UI overlays to the canvas so the camera zooms
    // instead of the page scrolling (e.g. annotation nav, tooltips, hotspots).
    // Preserve non-standard wheelDelta fields for input-mode classification.
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    dom.ui.addEventListener('wheel', (event: WheelEvent) => {
        event.preventDefault();
        const forwarded = new WheelEvent(event.type, event);
        const src = event as WheelEvent & {
            wheelDelta?: number, wheelDeltaX?: number, wheelDeltaY?: number
        };
        for (const key of ['wheelDelta', 'wheelDeltaX', 'wheelDeltaY'] as const) {
            if (typeof src[key] === 'number') {
                Object.defineProperty(forwarded, key, { value: src[key], configurable: true });
            }
        }
        canvas.dispatchEvent(forwarded);
    }, { passive: false });

    // Handle loading progress updates
    if (isLodMode && hideProgressBarInLodMode) {
        // Hide progress bar in LOD mode
        const loadingWrap = document.getElementById('loadingWrap');
        if (loadingWrap) {
            loadingWrap.classList.add('hidden');
        }
    } else {
        const progressGradient = 'linear-gradient(90deg, #FFFFFF 0%, #73CCFF 41.83%, #2061FD 100%)';
        events.on('progress:changed', (progress) => {
            dom.loadingText.textContent = `${progress}%`;
            dom.loadingIcon.style.left = `${progress}%`;
            if (progress < 100) {
                dom.loadingBar.style.background = 'rgba(255,255,255,0.25)'; // 未填充轨道
                dom.loadingBar.style.backgroundImage = progressGradient;
                dom.loadingBar.style.backgroundSize = `${progress}% 100%`;
                dom.loadingBar.style.backgroundRepeat = 'no-repeat';
            } else {
                dom.loadingBar.style.background = 'transparent';
                dom.loadingBar.style.backgroundImage = progressGradient;
                dom.loadingBar.style.backgroundSize = '100% 100%';
                dom.loadingBar.style.backgroundRepeat = 'no-repeat';
                // 勿在 progress===100 时提前藏条：streaming 路径须等 progressThresholdReached
                // 才能解开 loadingCameraControlsLocked；提前藏条会造成「条没了点不动」。
            }
        });
    }

    // Hide loading bar once loaded
    events.on('loaded:changed', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });

    // Hide loading bar when progress reaches threshold (50%) or animation starts
    const hideLoadingUI = () => {
        const loadingWrap = document.getElementById('loadingWrap');
        if (loadingWrap) {
            loadingWrap.classList.add('hidden');
        }
    };

    events.on('progressThresholdReached', hideLoadingUI);
    events.on('animationStarted', hideLoadingUI);

    // Fullscreen support
    const hasFullscreenAPI = docRoot.requestFullscreen && document.exitFullscreen;

    const requestFullscreen = () => {
        if (hasFullscreenAPI) {
            docRoot.requestFullscreen();
        } else {
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        }
    };

    const exitFullscreen = () => {
        if (hasFullscreenAPI) {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        } else {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    if (hasFullscreenAPI) {
        document.addEventListener('fullscreenchange', () => {
            state.isFullscreen = !!document.fullscreenElement;
        });
    }

    dom.enterFullscreen.addEventListener('click', requestFullscreen);
    dom.exitFullscreen.addEventListener('click', exitFullscreen);

    // toggle fullscreen when user switches between landscape portrait
    // orientation
    screen?.orientation?.addEventListener('change', () => {
        if (['landscape-primary', 'landscape-secondary'].includes(screen.orientation.type)) {
            requestFullscreen();
        } else {
            exitFullscreen();
        }
    });

    // update UI when fullscreen state changes
    events.on('isFullscreen:changed', (value) => {
        dom.enterFullscreen.classList[value ? 'add' : 'remove']('hidden');
        dom.exitFullscreen.classList[value ? 'remove' : 'add']('hidden');
    });

    // Performance mode toggle
    dom.performanceModeRow.addEventListener('click', () => {
        state.performanceMode = !state.performanceMode;
    });
    const updatePerformanceMode = () => {
        dom.performanceModeCheck.classList.toggle('active', state.performanceMode);
        localStorage.setItem('performanceMode', String(state.performanceMode));
    };
    events.on('performanceMode:changed', updatePerformanceMode);
    updatePerformanceMode();

    // Gaming controls toggle (settings row visible on mobile only)
    dom.gamingControlsRow.addEventListener('click', () => {
        state.gamingControls = !state.gamingControls;
    });
    const updateGamingSettingsVisibility = () => {
        const isDesktop = state.inputMode === 'desktop';
        dom.gamingControlsDivider.classList.toggle('hidden', isDesktop);
        dom.gamingControlsRow.classList.toggle('hidden', isDesktop);
    };
    events.on('inputMode:changed', updateGamingSettingsVisibility);
    updateGamingSettingsVisibility();

    const updateGamingControls = () => {
        dom.gamingControlsCheck.classList.toggle('active', state.gamingControls);
        if (state.inputMode !== 'desktop') {
            dom.desktopClickToWalk.classList.toggle('hidden', state.gamingControls);
            dom.desktopGamingControls.classList.toggle('hidden', !state.gamingControls);
        }
        dom.touchFlyClickToWalk.classList.toggle('hidden', state.gamingControls);
        dom.touchFlyGamingControls.classList.toggle('hidden', !state.gamingControls);
        dom.touchClickToWalk.classList.toggle('hidden', state.gamingControls);
        dom.touchGamingControls.classList.toggle('hidden', !state.gamingControls);
        localStorage.setItem('gamingControls', String(state.gamingControls));
    };
    events.on('gamingControls:changed', updateGamingControls);
    updateGamingControls();

    // AR/VR
    const arChanged = () => dom.arMode.classList[state.hasAR ? 'remove' : 'add']('hidden');
    const vrChanged = () => dom.vrMode.classList[state.hasVR ? 'remove' : 'add']('hidden');

    dom.arMode.addEventListener('click', () => events.fire('startAR'));
    dom.vrMode.addEventListener('click', () => events.fire('startVR'));

    events.on('hasAR:changed', arChanged);
    events.on('hasVR:changed', vrChanged);

    arChanged();
    vrChanged();

    // 编辑模式：左上侧栏、右侧多面板栏、底部资产栏、右上角按钮（showEditUI 为 false 时不挂载，仅保留逻辑）
    if (config.showEditUI !== false) {
        initEditLeftToolbarUI(global);
        initEditRightToolbarUI(global);
        initEditBottomToolbarUI(global);
    }
    /** 进入编辑模式时的 settings 快照（字符串用于比较是否有改动） */
    let editModeEnteredSettingsSnapshot: string | null = null;
    /** 进入编辑模式时的 settings 完整数据，用于「不保存并退出」时回退场景 */
    let editModeEnteredSettingsData: ExperienceSettings | null = null;
    /** 进入编辑后系统异步写入 collision.url 时同步基线，避免未编辑却弹出保存确认 */
    const syncEnteredBaselineCollisionFromSystem = () => {
        if (!state.editMode || !editModeEnteredSettingsData || editModeEnteredSettingsSnapshot == null) {
            return;
        }
        const patched = syncEditBaselineCollisionFromGlobal(editModeEnteredSettingsData, global);
        editModeEnteredSettingsData = patched.data;
        editModeEnteredSettingsSnapshot = patched.comparable;
    };
    events.on(SCENE_COLLISION_CHANGED, syncEnteredBaselineCollisionFromSystem);
    const resetSettingsBtn = dom.resetSettingsBtn as HTMLButtonElement | null;
    const updatePreviewModeButton = () => {
        if (!dom.previewModeBtn) return;
        const inPreviewMode = state.previewMode === true;
        dom.previewModeBtn.textContent = inPreviewMode ? '退出预览模式' : '进入预览模式';
    };
    const applyEditChromeVisibility = (inEdit: boolean) => {
        if (config.showEditUI === false) return;
        const leftMount = document.getElementById('editLeftSidebarMount');
        if (leftMount) {
            leftMount.classList.toggle('hidden', !inEdit);
        }
        if (dom.rightToolBar) {
            const showRight = inEdit && state.editLeftModule != null;
            dom.rightToolBar.classList.toggle('hidden', !showRight);
        }
        const bottomMount = document.getElementById('editBottomToolbarMount');
        if (bottomMount) {
            const showBottomBar = inEdit &&
                (state.editLeftModule === 'asset' ||
                    state.editLeftModule === 'annotation' ||
                    state.editLeftModule === 'environment');
            bottomMount.classList.toggle('hidden', !showBottomBar);
        }
        // 顶栏：编辑时显示「退出」+「保存」，非编辑时显示「编辑」
        if (dom.editModeStrip) {
            dom.editModeStrip.classList.toggle('edit-mode-active', inEdit);
        }
        if (dom.editModeBtn) {
            dom.editModeBtn.classList.toggle('hidden', inEdit);
        }
        if (dom.exitEditBtn) {
            dom.exitEditBtn.classList.toggle('hidden', !inEdit);
        }
        if (resetSettingsBtn) {
            resetSettingsBtn.classList.toggle('hidden', !inEdit);
        }
        if (dom.saveSettingsWrap) {
            dom.saveSettingsWrap.classList.toggle('hidden', !inEdit);
        }
        if (!inEdit) {
            dom.saveSettingsDropdown?.classList.add('hidden');
            dom.saveSettingsBtn?.setAttribute('aria-expanded', 'false');
        }
        const showUndoRedo = inEdit && config.trackEditHistory === true;
        if (dom.undoEditBtn) {
            dom.undoEditBtn.classList.toggle('hidden', !showUndoRedo);
        }
        if (dom.redoEditBtn) {
            dom.redoEditBtn.classList.toggle('hidden', !showUndoRedo);
        }
        if (dom.previewModeBtn) {
            dom.previewModeBtn.classList.toggle('hidden', !inEdit);
        }
    };
    const updateEditModeUI = async () => {
        const inEdit = state.editMode;
        // 先切换工具栏显隐，再执行异步恢复，避免首次点击因 await restore 导致工具栏延迟出现
        applyEditChromeVisibility(inEdit);
        if (inEdit) {
            if (editUiTransport !== 'message-bridge') {
                editModeEnteredSettingsSnapshot = null;
                // internal：进入编辑停播一次性 reveal，persistent（如 perlin）保留；退出编辑后再恢复 reveal 播放节奏。
                const hasVfxToResume = getRevealActiveType(state) !== 'none';
                if (hasVfxToResume) {
                    events.fire('vfxExit');
                }
                // 进入编辑时先清空模块（在异步恢复之前），避免 sceneAssets 恢复结束后覆盖用户已选模块
                state.editLeftModule = null;
                events.fire('editLeftModule:changed', null);

                // 进入编辑统一恢复原始配置（避免资产异步未完成时基线快照不一致）。
                const originalSettings = (global as any).__originalSettings as ExperienceSettings | undefined;
                if (originalSettings) {
                    // 立即设置退出时用的基线（使用原始配置，确保用户快速退出也能正确恢复）
                    editModeEnteredSettingsData = JSON.parse(JSON.stringify(originalSettings)) as ExperienceSettings;

                    const viewerSkyboxUrl = readSkyboxCurrentUrlFromSettings(global.settings as ExperienceSettings);
                    applySettingsSnapshot(global, JSON.parse(JSON.stringify(originalSettings)) as ExperienceSettings);
                    mergeSkyboxOnEditEnter(global, originalSettings, viewerSkyboxUrl);
                    await requestSceneAssetsRestore(global, { reason: 'edit-enter' });
                    restoreAnnotationsFromSettings(global);
                    restoreLightingFromSettings(global);
                    restorePostEffectsFromSettings(global);
                    applySkyboxOnEditEnter(global, originalSettings, viewerSkyboxUrl);
                }

                applyMorphKeyframeVisibilityPolicy(global);

                const initialSnapshot = serializeExperienceSettings(global);
                initEditHistory(global, initialSnapshot);
                editModeEnteredSettingsData = JSON.parse(JSON.stringify(initialSnapshot)) as ExperienceSettings;
                editModeEnteredSettingsSnapshot = getComparableSettingsStringFromSnapshot(initialSnapshot);
                applyEditChromeVisibility(state.editMode);
            }
        }
    };
    if (config.allowEditMode === false || config.showEditUI === false) {
        if (dom.editModeStrip) {
            dom.editModeStrip.classList.add('hidden');
        }
    } else {
        if (dom.editModeBtn) {
            dom.editModeBtn.addEventListener('click', () => {
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'EDIT_MODE_SET', value: true });
                    return;
                }
                state.editMode = true;
                events.fire('editMode:changed', true);
            });
        }
        if (dom.exitEditBtn) {
            dom.exitEditBtn.addEventListener('click', async () => {
                if (editUiTransport === 'message-bridge') {
                    // 两段式退出：先请求 Viewer 判断是否需要保存，再由确认弹窗决定后续命令
                    const waitFor = (t: string, timeoutMs = 1500) => new Promise<any>((resolve, reject) => {
                        const onMsg = (ev: MessageEvent) => {
                            const data = ev.data as any;
                            if (!data || data.type !== t) return;
                            window.removeEventListener('message', onMsg);
                            clearTimeout(to);
                            resolve(data);
                        };
                        const to = window.setTimeout(() => {
                            window.removeEventListener('message', onMsg);
                            reject(new Error(`timeout waiting for ${t}`));
                        }, timeoutMs);
                        window.addEventListener('message', onMsg);
                    });

                    // 1) 请求退出：由 bridge 基于 baseline 判断 needsSave
                    sendEditProtocolMessage({ type: 'EDIT_MODE_EXIT_REQUEST' });

                    // 2) 等待 needsSave 再弹窗
                    waitFor('EDIT_EXIT_NEEDS_SAVE')
                    .then((msg) => {
                        // bridge 使用顶层字段 { type, value }，与旧 payload.value 兼容
                        const needsSave = !!(msg?.value ?? msg?.payload?.value);
                        if (!needsSave) {
                            sendEditProtocolMessage({ type: 'EDIT_MODE_SET', value: false });
                            return;
                        }

                        showExitEditConfirmModal({
                            onSave: () => {
                                // 保存：由 bridge 生成 SETTINGS_UPDATED，再退出编辑模式
                                sendEditProtocolMessage({ type: 'SETTINGS_SAVE', destination: 'host' });
                                waitForSettingsSaveResult()
                                .finally(() => {
                                    sendEditProtocolMessage({ type: 'EDIT_MODE_SET', value: false });
                                });
                            },
                            onDiscard: () => {
                                sendEditProtocolMessage({ type: 'EDIT_MODE_EXIT_DISCARD' });
                            }
                        });
                    })
                    .catch(() => {
                        // 忽略：协议未返回时不做任何事，避免误退出
                    });

                    return;
                }

                const currentSnapshot = serializeExperienceSettings(global);
                const current = getComparableSettingsStringFromSnapshot(currentSnapshot);
                if (editModeEnteredSettingsSnapshot === null) {
                    if (editModeEnteredSettingsData) {
                        applySettingsSnapshot(global, editModeEnteredSettingsData);
                        await requestSceneAssetsRestore(global, { reason: 'edit-discard' });
                        restoreAnnotationsFromSettings(global);
                        restoreLightingFromSettings(global);
                        restorePostEffectsFromSettings(global);
                        restoreSkyboxFromSettings(global);
                    }
                    state.editMode = false;
                    applyMorphKeyframeVisibilityPolicy(global);
                    events.fire('editMode:changed', false);
                    return;
                }
                if (current === editModeEnteredSettingsSnapshot) {
                    state.editMode = false;
                    applyMorphKeyframeVisibilityPolicy(global);
                    events.fire('editMode:changed', false);
                    return;
                }
                if (editModeEnteredSettingsData) {
                    logSettingsDiffDetails(
                        '[UI] exit-edit needsSave',
                        editModeEnteredSettingsData,
                        currentSnapshot
                    );
                }
                showExitEditConfirmModal({
                    onSave: async () => {
                        const result = await saveExperienceProject(global, 'local');
                        if (result.ok === false) {
                            showEditToast(result.message || '保存失败', 'error');
                            return;
                        }
                        state.editMode = false;
                        applyMorphKeyframeVisibilityPolicy(global);
                        events.fire('editMode:changed', false);
                    },
                    onDiscard: async () => {
                        if (!editModeEnteredSettingsData) {
                            state.editMode = false;
                            applyMorphKeyframeVisibilityPolicy(global);
                            events.fire('editMode:changed', false);
                            return;
                        }
                        applySettingsSnapshot(global, editModeEnteredSettingsData);
                        await requestSceneAssetsRestore(global, { reason: 'edit-discard' });
                        // 恢复标注实体与 UI（保持与 message-bridge 下 EDIT_MODE_EXIT_DISCARD 一致）
                        restoreAnnotationsFromSettings(global);
                        // 统一通过 helper 按当前 settings 重置 Lighting / NightMode / PostEffect
                        restoreLightingFromSettings(global);
                        restorePostEffectsFromSettings(global);
                        restoreSkyboxFromSettings(global);
                        state.editMode = false;
                        applyMorphKeyframeVisibilityPolicy(global);
                        events.fire('editMode:changed', false);
                    }
                });
            });
        }
        /** 重置后仅刷新 undo 栈；退出时的 needsSave 基线不变（重置不算已保存） */
        const syncResetEditHistory = () => {
            if (!config.trackEditHistory) {
                return;
            }
            const payload = serializeExperienceSettings(global);
            const resetSnapshot = JSON.parse(JSON.stringify(payload)) as ExperienceSettings;
            initEditHistory(global, resetSnapshot);
            events.fire('editHistory:stateChanged', {
                canUndo: canUndo(global),
                canRedo: canRedo(global)
            });
        };

        const runSettingsReset = async () => {
            const btn = resetSettingsBtn;
            if (!btn) return;
            const label = btn.textContent ?? '重置场景';
            btn.disabled = true;
            btn.textContent = '重置中…';

            try {
                if (editUiTransport === 'message-bridge') {
                    const waitForResetResult = (timeoutMs = 30000) => new Promise<{ pathFrom?: string }>((resolve, reject) => {
                        const onMsg = (ev: MessageEvent) => {
                            const data = ev.data as {
                                    type?: string;
                                    message?: string;
                                    pathFrom?: string;
                                };
                            if (!data?.type) return;
                            if (
                                data.type !== 'SETTINGS_RESET_APPLIED' &&
                                    data.type !== 'SETTINGS_RESET_FAILED'
                            ) {
                                return;
                            }
                            window.removeEventListener('message', onMsg);
                            clearTimeout(to);
                            if (data.type === 'SETTINGS_RESET_FAILED') {
                                reject(new Error(
                                    typeof data.message === 'string' && data.message ?
                                        data.message :
                                        'SETTINGS_RESET_FAILED'
                                ));
                                return;
                            }
                            resolve({ pathFrom: data.pathFrom });
                        };
                        const to = window.setTimeout(() => {
                            window.removeEventListener('message', onMsg);
                            reject(new Error('timeout waiting for SETTINGS_RESET_APPLIED'));
                        }, timeoutMs);
                        window.addEventListener('message', onMsg);
                    });

                    sendEditProtocolMessage({ type: 'SETTINGS_RESET' });
                    const applied = await waitForResetResult();
                    syncResetEditHistory();
                    const msg = applied.pathFrom === 'original' ?
                        '场景已重置（已应用云端初始相机路径）' :
                        '场景已重置（未找到 transform.json，已保留当前动画路径与默认视角）';
                    showEditToast(msg, 'success');
                } else {
                    const result = await resetSceneSettings(global);
                    if (result.ok === false) {
                        showEditToast(result.message || '重置失败', 'error');
                        return;
                    }
                    syncResetEditHistory();
                    const msg = result.pathFrom === 'original' ?
                        '场景已重置（已应用云端初始相机路径）' :
                        '场景已重置（未找到 transform.json，已保留当前动画路径与默认视角）';
                    showEditToast(msg, 'success');
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                showEditToast(message || '重置失败', 'error');
            } finally {
                btn.textContent = label;
                btn.disabled = false;
            }
        };

        if (resetSettingsBtn) {
            resetSettingsBtn.addEventListener('click', () => {
                if (!state.editMode) return;
                confirmSceneReset({
                    onConfirm: () => runSettingsReset()
                });
            });
        }
        if (dom.saveSettingsBtn) {
            const saveBtn = dom.saveSettingsBtn as HTMLButtonElement;
            const saveDropdown = dom.saveSettingsDropdown;
            const closeSaveMenu = () => {
                saveDropdown?.classList.add('hidden');
                saveBtn.setAttribute('aria-expanded', 'false');
            };
            const runSettingsSave = async (destination: SettingsSaveDestination) => {
                closeSaveMenu();
                const okMsg = destination === 'universe' ? '已上传到 Universe' : '已保存到本地';
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'SETTINGS_SAVE', destination });
                    try {
                        await waitForSettingsSaveResult();
                        showEditToast(okMsg, 'success');
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        showEditToast(message || '保存失败', 'error');
                    }
                    return;
                }
                const result = await saveExperienceProject(global, destination);
                if (result.ok === false) {
                    showEditToast(result.message || '保存失败', 'error');
                    return;
                }
                showEditToast(okMsg, 'success');
                const payload = serializeExperienceSettings(global);
                // 编辑模式下手动保存后，将当前配置视为最新快照：
                // - 下次比较是否有改动时，以本次保存后的配置为基准
                // - 之后选择「不保存并退出」时，回退到最近一次保存的配置
                editModeEnteredSettingsSnapshot = getComparableSettingsString(global);
                editModeEnteredSettingsData = JSON.parse(JSON.stringify(payload)) as ExperienceSettings;
            };

            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!state.editMode) return;
                const open = saveDropdown?.classList.toggle('hidden') === false;
                saveBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
            saveDropdown?.querySelectorAll<HTMLButtonElement>('[data-destination]').forEach((option) => {
                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isLocalSave = option.dataset.destination === 'local' || option.dataset.destination === 'host';
                    const destination = isLocalSave ?
                        (editUiTransport === 'message-bridge' ? 'host' : 'local') :
                        'universe';
                    void runSettingsSave(destination);
                });
            });
            const dirInput = document.getElementById('importProjectDirInput') as HTMLInputElement | null;
            const runProjectImport = async (list: FileList | null) => {
                if (!list || list.length === 0) return;
                const result = await importLocalProject(list);
                if (result.ok === false) {
                    showEditToast(result.message || '导入失败', 'error');
                    return;
                }
                location.reload();
            };
            dirInput?.addEventListener('change', () => {
                void runProjectImport(dirInput.files);
                dirInput.value = '';
            });
            saveDropdown?.querySelectorAll<HTMLButtonElement>('[data-import]').forEach((option) => {
                option.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeSaveMenu();
                    dirInput?.click();
                });
            });
            document.addEventListener('click', (e) => {
                if (!dom.saveSettingsWrap?.contains(e.target as Node)) {
                    closeSaveMenu();
                }
            });
        }
        if (dom.previewModeBtn) {
            dom.previewModeBtn.addEventListener('click', () => {
                const nextValue = state.previewMode !== true;
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'PREVIEW_MODE_SET', value: nextValue });
                    if (nextValue) {
                        events.fire('mediaHotspot:userActivate');
                    }
                    return;
                }
                state.previewMode = nextValue;
                events.fire('previewMode:changed', nextValue);
                if (nextValue) {
                    events.fire('mediaHotspot:userActivate');
                }
            });
            updatePreviewModeButton();
        }

        let editHistoryRestoring = false;
        let editHistoryCanUndo = false;
        let editHistoryCanRedo = false;

        const applyUndoRedoState = () => {
            const undoRedoEnabled = config.trackEditHistory === true;
            const undoDisabled = !undoRedoEnabled || !state.editMode || editHistoryRestoring || !editHistoryCanUndo;
            const redoDisabled = !undoRedoEnabled || !state.editMode || editHistoryRestoring || !editHistoryCanRedo;

            if (dom.undoEditBtn) {
                dom.undoEditBtn.toggleAttribute('disabled', undoDisabled);
                dom.undoEditBtn.setAttribute('aria-disabled', undoDisabled ? 'true' : 'false');
                dom.undoEditBtn.classList.toggle('edit-mode-btn-disabled', undoDisabled);
            }
            if (dom.redoEditBtn) {
                dom.redoEditBtn.toggleAttribute('disabled', redoDisabled);
                dom.redoEditBtn.setAttribute('aria-disabled', redoDisabled ? 'true' : 'false');
                dom.redoEditBtn.classList.toggle('edit-mode-btn-disabled', redoDisabled);
            }
        };

        if (dom.undoEditBtn) {
            dom.undoEditBtn.addEventListener('click', async () => {
                if (!state.editMode) return;
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'EDIT_UNDO' });
                    return;
                }
                if (!canUndo(global)) return;
                await undo(global);
                // 撤销完成后，历史模块会通过 editHistory:stateChanged 更新状态
            });
        }
        if (dom.redoEditBtn) {
            dom.redoEditBtn.addEventListener('click', async () => {
                if (!state.editMode) return;
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'EDIT_REDO' });
                    return;
                }
                if (!canRedo(global)) return;
                await redo(global);
                // 重做完成后，历史模块会通过 editHistory:stateChanged 更新状态
            });
        }

        events.on('editHistory:restoring', (restoring: boolean) => {
            editHistoryRestoring = restoring;
            applyUndoRedoState();
        });

        events.on('editHistory:stateChanged', (payload: { canUndo: boolean; canRedo: boolean }) => {
            editHistoryCanUndo = payload.canUndo;
            editHistoryCanRedo = payload.canRedo;
            applyUndoRedoState();
        });

        events.on('editMode:changed', updateEditModeUI);
        events.on('previewMode:changed', () => {
            updatePreviewModeButton();
        });
        events.on('editLeftModule:changed', () => {
            const bottomMount = document.getElementById('editBottomToolbarMount');
            if (bottomMount && state.editMode) {
                const showBottomBar = state.editLeftModule === 'asset' ||
                    state.editLeftModule === 'annotation' ||
                    state.editLeftModule === 'environment';
                bottomMount.classList.toggle('hidden', !showBottomBar);
            }
            if (dom.rightToolBar) {
                const showRight = state.editMode && state.editLeftModule != null;
                dom.rightToolBar.classList.toggle('hidden', !showRight);
            }
            applyEnvironmentPreviewVisualPolicy(global);
        });
        updateEditModeUI();
    }

    // --- View 模式 Scene Content 显隐调试面板 ---
    initViewSceneContentDebugUI(global);

    if (dom.viewDebugMediaMute) {
        dom.viewDebugMediaMute.addEventListener('click', () => {
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'VIEW_MEDIA_MUTE_SET', value: true });
                applyViewMediaMuteSet(global, true);
            } else {
                applyViewMediaMuteSet(global, true);
            }
        });
    }

    if (dom.viewDebugMediaUnmute) {
        dom.viewDebugMediaUnmute.addEventListener('click', () => {
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'VIEW_MEDIA_MUTE_SET', value: false });
                applyViewMediaMuteSet(global, false);
            } else {
                applyViewMediaMuteSet(global, false);
            }
        });
    }

    if (dom.viewDebugMorphStopAll) {
        dom.viewDebugMorphStopAll.addEventListener('click', () => {
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ASSET_EFFECT_MORPH_STOP_ALL', module: 'effects' });
            } else if (
                !dispatchEffectsModuleCommand(global, {
                    type: 'ASSET_EFFECT_MORPH_STOP_ALL',
                    source: 'host'
                })
            ) {
                console.warn('[ui] command dispatch failed', 'ASSET_EFFECT_MORPH_STOP_ALL');
            }
        });
    }

    // 手电筒（全局单例 spot）：View 顶栏仅 Toggle；参数编辑在 Edit Lighting 面板。
    const torchToggleBtn = dom.viewDebugTorchToggle as HTMLButtonElement | undefined;
    if (torchToggleBtn) {
        const refreshTorchToggleStyle = () => {
            const active = readViewTorchActive(global);
            torchToggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
            torchToggleBtn.classList.toggle('active', active);
        };
        refreshTorchToggleStyle();
        torchToggleBtn.addEventListener('click', () => {
            const next = !readViewTorchActive(global);
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'TORCH_TOGGLE', value: next });
                // message-bridge 模式：父级回环写入后由 torchActive:changed 触发刷新；
                // 但 internal 与 host 入站均同步走 applyViewTorchActive → torchActive:changed，
                // 这里也直接调用以避免父级未回环时按钮态滞后。
                applyViewTorchActive(global, next);
            } else {
                applyViewTorchActive(global, next);
            }
        });
        // 任意路径写入 `viewSettings.torch.active` 都会触发 `torchActive:changed`，刷新按钮态。
        events.on('torchActive:changed', refreshTorchToggleStyle);
    }

    // 单个局部亮灯区域：下拉选区域，点击「Toggle 区域灯」切换该区域绑定光源的开关
    const viewDebugRegionSelect = dom.viewDebugRegionSelect as HTMLSelectElement | undefined;
    const viewDebugToggleRegionLight = dom.viewDebugToggleRegionLight;
    const refreshViewDebugRegionSelect = () => {
        if (!viewDebugRegionSelect) return;
        const bloom = (global.settings as any)?.postEffectSettings?.bloom;
        const regions = (bloom?.localLightRegions as Array<{ id: string; name?: string; linkedLightId?: string }>) ?? [];
        viewDebugRegionSelect.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '（无）';
        viewDebugRegionSelect.appendChild(none);
        regions.forEach((r, i) => {
            const opt = document.createElement('option');
            opt.value = r.linkedLightId ?? '';
            opt.textContent = r.name || `区域${i + 1}`;
            viewDebugRegionSelect.appendChild(opt);
        });
        if (viewDebugToggleRegionLight) {
            viewDebugToggleRegionLight.toggleAttribute('disabled', regions.length === 0 || !viewDebugRegionSelect.value);
        }
    };
    if (viewDebugRegionSelect) {
        viewDebugRegionSelect.addEventListener('change', () => {
            if (viewDebugToggleRegionLight) {
                viewDebugToggleRegionLight.toggleAttribute('disabled', !viewDebugRegionSelect.value);
            }
        });
        events.on('loaded:changed', refreshViewDebugRegionSelect);
        events.on('postEffect:changed', refreshViewDebugRegionSelect);
        refreshViewDebugRegionSelect();
    }
    if (viewDebugToggleRegionLight) {
        viewDebugToggleRegionLight.addEventListener('click', () => {
            const linkedLightId = viewDebugRegionSelect?.value;
            if (!linkedLightId) return;
            const lighting = (global.settings as any)?.lighting;
            const lights = lighting?.lights as Array<{ id?: string; enabled?: boolean }> | undefined;
            const light = Array.isArray(lights) ? lights.find(l => l && l.id === linkedLightId) : undefined;
            const nextEnabled = light ? !(light.enabled !== false) : true;
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'LIGHT_TOGGLE', id: linkedLightId, value: nextEnabled });
            } else {
                applyLightToggle(global, linkedLightId, nextEnabled);
            }
        });
    }

    // showEditUI 为 false 时也监听 editMode:changed，以便进入编辑模式时执行 initEditHistory 与快照逻辑（供 message-bridge 退出/保存用）
    if (config.showEditUI === false) {
        events.on('editMode:changed', updateEditModeUI);
        updateEditModeUI();
    }

    // Reveal / 场景特效、Lighting、PostEffect、VideoExport、Annotation 由独立组件管理，挂载到 edit-right-toolbar 提供的容器（showEditUI 为 false 时不挂载）
    if (config.showEditUI !== false) {
        initRevealUI(global);
        initAssetEffectsUI(global);
        initVideoExportUI(global);
        initLightingUI(global);
        initPostEffectUI(global);
        // 标注面板/系统与 reveal 播放时机对齐：
        // - 有 reveal：等 revealComplete 后再初始化，避免开场动画期间提前出现热点/tooltip
        // - 无 reveal：首帧后初始化（确保与 viewer 初始化阶段顺序一致）
        let annotationUiInitialized = false;
        const initAnnotationUiIfNeeded = () => {
            if (annotationUiInitialized) return;
            annotationUiInitialized = true;
            initAnnotationUI(global);
        };
        events.once('revealComplete', initAnnotationUiIfNeeded);
        events.once('firstFrame', () => {
            if (!state.hasRevealEffect) {
                initAnnotationUiIfNeeded();
            }
        });
    }

    // Info panel
    const updateInfoTab = (tab: 'desktop' | 'touch') => {
        if (tab === 'desktop') {
            dom.desktopTab.classList.add('active');
            dom.touchTab.classList.remove('active');
            dom.desktopInfoPanel.classList.remove('hidden');
            dom.touchInfoPanel.classList.add('hidden');
        } else {
            dom.desktopTab.classList.remove('active');
            dom.touchTab.classList.add('active');
            dom.desktopInfoPanel.classList.add('hidden');
            dom.touchInfoPanel.classList.remove('hidden');
        }
    };

    dom.desktopTab.addEventListener('click', () => {
        updateInfoTab('desktop');
    });

    dom.touchTab.addEventListener('click', () => {
        updateInfoTab('touch');
    });

    const toggleHelp = () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('hidden');
    };

    dom.info.addEventListener('click', toggleHelp);

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('hidden');
    });

    events.on('inputEvent', (event) => {
        if (event === 'toggleHelp') {
            toggleHelp();
        } else if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('hidden');
            dom.settingsPanel.classList.add('hidden');

            // close fullscreen on cancel
            if (state.isFullscreen) {
                exitFullscreen();
            }
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('hidden');
        }
    });

    // fade ui controls after 5 seconds of inactivity
    events.on('controlsHidden:changed', (value) => {
        // If noBottomUI is enabled, always keep controlsWrap hidden
        if (config.noBottomUI) {
            dom.controlsWrap.classList.add('hidden');
            dom.controlsWrap.classList.remove('faded-in', 'faded-out');
            // 确保使用display:none来完全隐藏，防止任何显示
            dom.controlsWrap.style.display = 'none';
            return;
        }
        dom.controlsWrap.style.display = '';
        dom.controlsWrap.className = value ? 'faded-out' : 'faded-in';
    });

    // show the ui and start a timer to hide it again
    let uiTimeout: ReturnType<typeof setTimeout> | null = null;
    let annotationVisible = false;

    const showUI = () => {
        // If noBottomUI is enabled, don't show UI
        if (config.noBottomUI) {
            return;
        }
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        state.controlsHidden = false;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            if (!annotationVisible) {
                state.controlsHidden = true;
            }
        }, 4000);
    };
    // Only show UI initially if noBottomUI is not enabled
    if (!config.noBottomUI) {
        showUI();
    }

    // Show controls once loaded
    events.on('loaded:changed', () => {
        if (config.noBottomUI) {
            return;
        }
        dom.controlsWrap.classList.remove('hidden');
        showUI();
    });

    events.on('inputEvent', showUI);

    // keep UI visible while an annotation tooltip is shown
    events.on('annotation.activate', () => {
        annotationVisible = true;
        showUI();
    });

    events.on('annotation.deactivate', () => {
        annotationVisible = false;
        showUI();
    });

    // Animation controls
    events.on('hasAnimation:changed', (value, prev) => {
        // Start and Stop animation
        dom.play.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = false;
        });

        dom.pause.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = true;
        });

        const updatePlayPause = () => {
            if (state.cameraMode !== 'anim' || state.animationPaused) {
                dom.play.classList.remove('hidden');
                dom.pause.classList.add('hidden');
            } else {
                dom.play.classList.add('hidden');
                dom.pause.classList.remove('hidden');
            }

            if (state.cameraMode === 'anim') {
                dom.timelineContainer.classList.remove('hidden');
            } else {
                dom.timelineContainer.classList.add('hidden');
            }
        };

        // Update UI on animation changes
        events.on('cameraMode:changed', updatePlayPause);
        events.on('animationPaused:changed', updatePlayPause);

        const updateSlider = () => {
            dom.handle.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.innerText = `${state.animationTime.toFixed(1)}s`;
        };

        events.on('animationTime:changed', updateSlider);
        events.on('animationLength:changed', updateSlider);

        const handleScrub = (event: PointerEvent) => {
            const rect = dom.timelineContainer.getBoundingClientRect();
            const t = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left)) / rect.width;
            events.fire('scrubAnim', state.animationDuration * t);
            showUI();
        };

        let paused = false;
        let captured = false;

        dom.timelineContainer.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!captured) {
                handleScrub(event);
                dom.timelineContainer.setPointerCapture(event.pointerId);
                dom.time.classList.remove('hidden');
                paused = state.animationPaused;
                state.animationPaused = true;
                captured = true;
            }
        });

        dom.timelineContainer.addEventListener('pointermove', (event: PointerEvent) => {
            if (captured) {
                handleScrub(event);
            }
        });

        dom.timelineContainer.addEventListener('pointerup', (event) => {
            if (captured) {
                dom.timelineContainer.releasePointerCapture(event.pointerId);
                dom.time.classList.add('hidden');
                state.animationPaused = paused;
                captured = false;
            }
        });
    });

    // Camera mode UI
    const updateCameraModeUI = () => {
        dom.orbitCamera.classList.toggle('active', state.cameraMode === 'orbit');
        dom.flyCamera.classList.toggle('active', state.cameraMode === 'fly');
        dom.fpsCamera.classList.toggle('active', state.cameraMode === 'walk');
    };

    events.on('cameraMode:changed', updateCameraModeUI);

    // Walk mode hint banner (shown once per session on first walk entry)
    let walkHintShown = false;
    const getWalkHintText = () => {
        if (state.inputMode === 'desktop') {
            return 'Click to walk. WASD to move freely.';
        }
        return state.gamingControls ?
            'Use the joystick to move. Drag to look around. Tap to jump.' :
            'Tap to walk. Drag to look around.';
    };

    events.on('cameraMode:changed', (value: string) => {
        if (value === 'walk' && !walkHintShown) {
            walkHintShown = true;
            dom.walkHint.textContent = getWalkHintText();
            dom.walkHint.classList.remove('hidden');
        } else if (value !== 'walk') {
            dom.walkHint.classList.add('hidden');
        }
    });
    const dismissWalkHint = () => dom.walkHint.classList.add('hidden');
    dom.walkHint.addEventListener('click', dismissWalkHint);
    events.on('inputEvent', (type: string) => {
        if (type === 'interrupt') dismissWalkHint();
    });

    // Show/hide walk button based on collision data
    events.on('hasCollision:changed', (value: boolean) => {
        dom.fpsCamera.classList.toggle('hidden', !value);
        dom.flyCamera.classList.toggle('middle', value);
        dom.flyCamera.classList.toggle('right', !value);
    });

    // Collision overlay toggle（voxel / mesh 共用）
    events.on('hasCollisionOverlay:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('hidden', !value);
    });
    dom.showCollision.addEventListener('click', () => {
        state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
    });
    events.on('collisionOverlayEnabled:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('active', value);
    });

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });

    dom.orbitCamera.addEventListener('click', () => {
        state.cameraMode = 'orbit';
    });

    dom.flyCamera.addEventListener('click', () => {
        state.cameraMode = 'fly';
    });

    dom.fpsCamera.addEventListener('click', () => {
        events.fire('inputEvent', 'toggleWalk');
    });

    dom.reset.addEventListener('click', (event) => {
        events.fire('inputEvent', 'reset', event);
    });

    dom.frame.addEventListener('click', (event) => {
        events.fire('inputEvent', 'frame', event);
    });

    dom.getCameraInfo.addEventListener('click', () => {
        events.fire('getCameraInfo');
    });

    // Initialize touch joystick (visibility managed by mode + gamingControls)
    initJoystick(dom, events, state, settings);

    // Initialize annotation navigator
    initAnnotationNav(dom, events, state, global.settings.annotations);

    // Hide all UI (poster, loading bar, controls)
    if (config.noui) {
        dom.ui.classList.add('hidden');
    }

    // Hide only bottom UI controls (keep poster and loading bar)
    // This must be done after all event listeners are set up to ensure it stays hidden
    if (config.noBottomUI) {
        dom.controlsWrap.classList.add('hidden');
        dom.controlsWrap.classList.remove('faded-in', 'faded-out');
        // 确保使用display:none来完全隐藏，防止任何显示
        dom.controlsWrap.style.display = 'none';
        // Also set controlsHidden to true to prevent any fade animations
        state.controlsHidden = true;
    }
    // Camera path visualization toggle
    dom.cameraPathOption.addEventListener('click', () => {
        state.showCameraPath = !state.showCameraPath;
    });

    events.on('showCameraPath:changed', (value) => {
        if (value) {
            dom.cameraPathCheck.classList.remove('hidden');
            dom.cameraPathCheck.classList.add('active');
        } else {
            dom.cameraPathCheck.classList.add('hidden');
            dom.cameraPathCheck.classList.remove('active');
        }
    });

    // Camera bounding box visualization toggle (independent from camera path)
    dom.cameraBoundsOption.addEventListener('click', () => {
        state.showCameraBoundingBox = !state.showCameraBoundingBox;
    });

    events.on('showCameraBoundingBox:changed', (value) => {
        if (value) {
            dom.cameraBoundsCheck.classList.remove('hidden');
            dom.cameraBoundsCheck.classList.add('active');
        } else {
            dom.cameraBoundsCheck.classList.add('hidden');
            dom.cameraBoundsCheck.classList.remove('active');
        }
    });

    // tooltips
    const tooltip = new Tooltip(dom.tooltip);

    tooltip.register(dom.play, 'Play', 'top');
    tooltip.register(dom.pause, 'Pause', 'top');
    tooltip.register(dom.orbitCamera, 'Orbit Camera', 'top');
    tooltip.register(dom.flyCamera, 'Fly Camera', 'top');
    tooltip.register(dom.fpsCamera, 'Walk Mode', 'top');
    tooltip.register(dom.reset, 'Reset Camera', 'bottom');
    tooltip.register(dom.frame, 'Frame Scene', 'bottom');
    tooltip.register(dom.showCollision, 'Show Collision', 'top');
    tooltip.register(dom.settings, 'Settings', 'top');
    tooltip.register(dom.info, 'Help', 'top');
    tooltip.register(dom.arMode, 'Enter AR', 'top');
    tooltip.register(dom.vrMode, 'Enter VR', 'top');
    tooltip.register(dom.enterFullscreen, 'Fullscreen', 'top');
    tooltip.register(dom.exitFullscreen, 'Fullscreen', 'top');
    tooltip.register(
        resetSettingsBtn,
        '重置场景：优先云端 transform.json 相机路径；无文件则保留当前 animTrack 与默认视角',
        'top'
    );
    tooltip.register(dom.saveSettingsBtn, '保存到本地，或上传到 Universe', 'top');
    tooltip.register(dom.undoEditBtn, 'Undo (Ctrl/Cmd+Z)', 'top');
    tooltip.register(dom.redoEditBtn, 'Redo (Ctrl/Cmd+Shift+Z)', 'top');
    tooltip.register(dom.previewModeBtn, '预览体验：隐藏操作轴与调试线框，并启用音视频热区自动播控', 'top');

    // 全局 Undo/Redo 快捷键，仅在编辑模式下生效
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
    const shouldIgnoreKeyEventTarget = (target: EventTarget | null) => {
        if (!target || !(target as HTMLElement).tagName) return false;
        const el = target as HTMLElement;
        const tag = el.tagName;
        if (el.isContentEditable) return true;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return false;
    };

    document.addEventListener(
        'keydown',
        async (event: KeyboardEvent) => {
            if (!state.editMode || config.trackEditHistory !== true) return;
            if (shouldIgnoreKeyEventTarget(event.target)) return;

            const primary = isMac ? event.metaKey : event.ctrlKey;
            if (!primary) return;

            const key = event.key.toLowerCase();
            const isRedoCombo =
                (!isMac && key === 'y') ||
                (key === 'z' && event.shiftKey);
            const isUndoCombo = key === 'z' && !event.shiftKey;

            if (!isUndoCombo && !isRedoCombo) return;

            if (isUndoCombo) {
                if (!canUndo(global)) return;
                event.preventDefault();
                await undo(global);
            } else if (isRedoCombo) {
                if (!canRedo(global)) return;
                event.preventDefault();
                await redo(global);
            }
        },
        { passive: true } // 不会阻止默认行为
    );

    const isThirdPartyEmbedded = () => {
        try {
            return window.location.hostname !== window.parent.location.hostname;
        } catch (e) {
            // cross-origin iframe — parent location is inaccessible
            return true;
        }
    };

    if (window.parent !== window && isThirdPartyEmbedded()) {
        const viewUrl = new URL(window.location.href);
        if (viewUrl.pathname === '/s') {
            viewUrl.pathname = '/view';
        }

        // (dom.supersplatBranding as HTMLAnchorElement).href = viewUrl.toString();
        // dom.supersplatBranding.classList.remove('hidden');
    }
};

export { initPoster, initUI };
