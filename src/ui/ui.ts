import { EventHandler } from 'playcanvas';

import { Tooltip } from '../tooltip';
import { Global } from '../types';
import { isLodMetaFile } from '../loaders/lod-loader';
import type { ExperienceSettings } from '../schemas/v2';
import { serializeExperienceSettings, getComparableSettingsString, applySettingsSnapshot } from '../settings-serialize';
import { clearScenePlacedEntities, restoreSceneAssetsFromSettings } from '../asset-placement-handler';
import { initEditHistory, canUndo, canRedo, undo, redo } from '../edit-history';
import { showExitEditConfirmModal } from './components/exit-edit-confirm-ui';
import { initRevealUI } from './components/reveal-ui';
import { initVideoExportUI } from './components/video-export-ui';
import { initLightingUI } from './components/lighting-ui';
import { initPostEffectUI } from './components/post-effect-ui';
import { initAnnotationUI } from './components/annotation-ui';
import { initEditLeftToolbarUI } from './edit-left-toolbar';
import { initEditRightToolbarUI } from './edit-right-toolbar';
import { initEditBottomToolbarUI } from './edit-bottom-toolbar';
import type { Annotation } from '../settings';

// Initialize the touch joystick for fly mode camera control
const initJoystick = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { cameraMode: string; inputMode: string }
) => {
    // Joystick dimensions (matches SCSS: base height=120, stick size=48)
    const joystickHeight = 120;
    const stickSize = 48;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 36px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 36px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 36px up or down from center

    // Fixed joystick position (bottom-left corner with safe area)
    const joystickFixedX = 70;
    const joystickFixedY = () => window.innerHeight - 140;

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward

    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode: '1d' | '2d' = '2d';

    // Double-tap detection for mode toggle
    let lastTapTime = 0;

    // Update joystick visibility based on camera mode and input mode
    const updateJoystickVisibility = () => {
        if (state.cameraMode === 'fly' && state.inputMode === 'touch') {
            dom.joystickBase.classList.remove('hidden');
            dom.joystickBase.classList.toggle('mode-2d', joystickMode === '2d');
            dom.joystickBase.style.left = `${joystickFixedX}px`;
            dom.joystickBase.style.top = `${joystickFixedY()}px`;
            // Center the stick
            dom.joystick.style.top = `${stickCenterY}px`;
            if (joystickMode === '2d') {
                dom.joystick.style.left = `${stickCenterX}px`;
            } else {
                dom.joystick.style.left = '8px'; // Reset to 1D centered position
            }
        } else {
            dom.joystickBase.classList.add('hidden');
        }
    };

    events.on('cameraMode:changed', updateJoystickVisibility);
    events.on('inputMode:changed', updateJoystickVisibility);
    window.addEventListener('resize', updateJoystickVisibility);

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        const baseY = joystickFixedY();
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = joystickFixedX;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;

            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        } else {
            joystickValueX = 0;
        }

        // Fire input event for the input controller
        events.fire('joystickInput', { x: joystickValueX, y: joystickValueY });
    };

    dom.joystickBase.addEventListener('pointerdown', (event: PointerEvent) => {
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        } else {
            lastTapTime = now;
        }

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
        if (joystickMode === '2d') {
            dom.joystick.style.left = `${stickCenterX}px`;
        }

        // Fire input event with zero values
        events.fire('joystickInput', { x: 0, y: 0 });

        dom.joystickBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
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
    const { config, events, state } = global;

    // Acquire Elements
    const docRoot = document.documentElement;
    const dom = [
        'ui',
        'controlsWrap',
        'editModeStrip', 'editModeBtn', 'exitEditBtn', 'saveSettingsBtn', 'undoEditBtn', 'redoEditBtn', 'rightToolBar',
        'arMode', 'vrMode',
        'enterFullscreen', 'exitFullscreen',
        'info', 'infoPanel', 'desktopTab', 'touchTab', 'desktopInfoPanel', 'touchInfoPanel',
        'timelineContainer', 'handle', 'time',
        'buttonContainer',
        'play', 'pause',
        'settings', 'settingsPanel',
        'orbitCamera', 'flyCamera',
        'hqCheck', 'hqOption', 'lqCheck', 'lqOption',
        'cameraPathCheck', 'cameraPathOption',
        'cameraBoundsCheck', 'cameraBoundsOption',
        'skyboxRow', 'skyboxSelect',
        'vfxSubmenuHeader', 'vfxSubpanel', 'vfxSubmenuArrow',
        'lightingSubmenuHeader', 'lightingSubpanel', 'lightingSubmenuArrow',
        'postEffectSubmenuHeader', 'postEffectSubpanel', 'postEffectSubmenuArrow',
        'renderSubmenuHeader', 'renderSubpanel', 'renderSubmenuArrow',
        'reset', 'frame',
        'getCameraInfo',
        'loadingText', 'loadingBar', 'loadingIcon',
        'joystickBase', 'joystick',
        'tooltip',
        'annotationNav', 'annotationPrev', 'annotationNext', 'annotationInfo', 'annotationNavTitle',
        'supersplatBranding'
    ].reduce((acc: Record<string, HTMLElement>, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, {});

    // Check if LOD mode is enabled
    const isLodMode = config.contentUrl ? isLodMetaFile(config.contentUrl) : false;
    
    // In LOD mode, show progress bar but mark as 100% when animation starts
    // Progress is calculated based on threshold, reaching 100% when animation begins
    const hideProgressBarInLodMode = false;
    // Forward wheel events from UI overlays to the canvas so the camera zooms
    // instead of the page scrolling (e.g. annotation nav, tooltips, hotspots)
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    dom.ui.addEventListener('wheel', (event: WheelEvent) => {
        event.preventDefault();
        canvas.dispatchEvent(new WheelEvent(event.type, event));
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
                // In LOD mode, hide loading UI when progress reaches 100%
                if (isLodMode) {
                    const loadingWrap = document.getElementById('loadingWrap');
                    if (loadingWrap) {
                        loadingWrap.classList.add('hidden');
                    }
                }
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
    screen?.orientation?.addEventListener('change', (event) => {
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

    // HQ mode
    dom.hqOption.addEventListener('click', () => {
        state.hqMode = true;
    });
    dom.lqOption.addEventListener('click', () => {
        state.hqMode = false;
    });

    const updateHQ = () => {
        dom.hqCheck.classList[state.hqMode ? 'add' : 'remove']('active');
        dom.lqCheck.classList[state.hqMode ? 'remove' : 'add']('active');
    };
    events.on('hqMode:changed', (value) => {
        updateHQ();
    });
    updateHQ();

    // Skybox selector
    const skyboxRow = dom.skyboxRow;
    const skyboxSelect = dom.skyboxSelect as HTMLSelectElement;

    const deriveSkyboxLabel = (value: string) => {
        try {
            const decoded = decodeURIComponent(value);
            const filename = decoded.split('/').pop() || decoded;
            const withoutExt = filename.replace(/\.[^.]+$/, '');
            return withoutExt || decoded;
        } catch (err) {
            return value;
        }
    };

    const ensureOption = (value: string, label: string) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
    };

    const populateSkyboxes = async () => {
        if (!skyboxSelect || !skyboxRow) {
            return;
        }

        try {
            skyboxRow.classList.add('hidden');

            const response = await fetch('/assets/skyboxes/index.json', {
                cache: 'force-cache'
            });

            if (!response.ok) {
                throw new Error(`Failed to load skybox list: ${response.status}`);
            }

            type SkyboxManifestEntry = string | { label?: string; name?: string; file?: string; url?: string };

            const manifest = await response.json() as SkyboxManifestEntry[];
            const normalized = manifest
                .map((entry) => {
                    if (typeof entry === 'string') {
                        return {
                            label: deriveSkyboxLabel(entry),
                            value: `/assets/skyboxes/${entry}`
                        };
                    }

                    const file = entry.file ?? '';
                    const rawValue = entry.url ?? (file ? `/assets/skyboxes/${file}` : '');
                    if (!rawValue) {
                        return null;
                    }

                    return {
                        label: entry.label ?? entry.name ?? deriveSkyboxLabel(file || rawValue),
                        value: rawValue
                    };
                })
                .filter((item): item is { label: string; value: string } => !!item?.value);

            const current = config.skyboxUrl ?? '';

            skyboxSelect.innerHTML = '';

            skyboxSelect.appendChild(ensureOption('', 'No Skybox'));

            normalized.forEach(({ label, value }) => {
                skyboxSelect.appendChild(ensureOption(value, label));
            });

            if (current && !normalized.some(({ value }) => value === current)) {
                skyboxSelect.appendChild(ensureOption(current, deriveSkyboxLabel(current)));
            }

            skyboxSelect.value = current || '';
            skyboxRow.classList.remove('hidden');
        } catch (err) {
            console.warn('[SuperSplat] 无法加载天空盒列表：', err);
            skyboxRow?.classList.add('hidden');
        }
    };

    if (skyboxSelect) {
        skyboxSelect.addEventListener('change', (event) => {
            const value = (event.target as HTMLSelectElement).value;
            events.fire('skyboxSwitch', value || null);
        });

        events.on('skyboxSelectionSynced', (value?: string | null) => {
            skyboxSelect.value = value ?? '';
        });

        populateSkyboxes();
    }

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
    const updateEditModeUI = () => {
        const inEdit = state.editMode;
        if (inEdit) {
            const initialSnapshot = serializeExperienceSettings(global);
            initEditHistory(global, initialSnapshot);

            editModeEnteredSettingsSnapshot = getComparableSettingsString(global);
            editModeEnteredSettingsData = JSON.parse(
                JSON.stringify(initialSnapshot)
            ) as ExperienceSettings;
        }
        if (config.showEditUI !== false) {
            const leftMount = document.getElementById('editLeftSidebarMount');
            if (leftMount) {
                leftMount.classList.toggle('hidden', !inEdit);
            }
            if (dom.rightToolBar) {
                dom.rightToolBar.classList.toggle('hidden', !inEdit);
            }
            const bottomMount = document.getElementById('editBottomToolbarMount');
            if (bottomMount) {
                const showBottomBar = inEdit && (state.editLeftModule === 'asset' || state.editLeftModule === 'annotation');
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
            if (dom.saveSettingsBtn) {
                dom.saveSettingsBtn.classList.toggle('hidden', !inEdit);
            }
            const showUndoRedo = inEdit && config.trackEditHistory === true;
            if (dom.undoEditBtn) {
                dom.undoEditBtn.classList.toggle('hidden', !showUndoRedo);
            }
            if (dom.redoEditBtn) {
                dom.redoEditBtn.classList.toggle('hidden', !showUndoRedo);
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
                state.editMode = true;
            });
        }
        if (dom.exitEditBtn) {
            dom.exitEditBtn.addEventListener('click', () => {
                const current = getComparableSettingsString(global);
                if (editModeEnteredSettingsSnapshot === null || current === editModeEnteredSettingsSnapshot) {
                    state.editMode = false;
                    return;
                }
                showExitEditConfirmModal({
                    onSave: () => {
                        const payload = serializeExperienceSettings(global);
                        const jsonString = JSON.stringify(payload, null, 2);
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(new Blob([jsonString], { type: 'application/json' }));
                        a.download = 'settings.json';
                        a.click();
                        URL.revokeObjectURL(a.href);
                        window.parent.postMessage({ type: 'SETTINGS_UPDATED', message: 'settings updated', payload: jsonString }, '*');
                        state.editMode = false;
                    },
                    onDiscard: async () => {
                        if (!editModeEnteredSettingsData) {
                            state.editMode = false;
                            return;
                        }
                        applySettingsSnapshot(global, editModeEnteredSettingsData);
                        clearScenePlacedEntities(global);
                        await restoreSceneAssetsFromSettings(global);
                        state.editMode = false;
                    }
                });
            });
        }
        if (dom.saveSettingsBtn) {
            dom.saveSettingsBtn.addEventListener('click', () => {
                const payload = serializeExperienceSettings(global);
                const jsonString = JSON.stringify(payload, null, 2);
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([jsonString], { type: 'application/json' }));
                a.download = 'settings.json';
                a.click();
                URL.revokeObjectURL(a.href);
                window.parent.postMessage({ type: 'SETTINGS_UPDATED', message: 'settings updated', payload: jsonString }, '*');

                // 编辑模式下手动点击「保存配置」后，将当前配置视为最新快照：
                // - 下次比较是否有改动时，以本次保存后的配置为基准
                // - 之后选择「不保存并退出」时，回退到最近一次保存的配置
                editModeEnteredSettingsSnapshot = getComparableSettingsString(global);
                editModeEnteredSettingsData = JSON.parse(JSON.stringify(payload)) as ExperienceSettings;
            });
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
                if (!canUndo(global)) return;
                await undo(global);
                // 撤销完成后，历史模块会通过 editHistory:stateChanged 更新状态
            });
        }
        if (dom.redoEditBtn) {
            dom.redoEditBtn.addEventListener('click', async () => {
                if (!state.editMode) return;
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
        events.on('editLeftModule:changed', () => {
            const bottomMount = document.getElementById('editBottomToolbarMount');
            if (bottomMount && state.editMode) {
                const showBottomBar = state.editLeftModule === 'asset' || state.editLeftModule === 'annotation';
                bottomMount.classList.toggle('hidden', !showBottomBar);
            }
        });
        updateEditModeUI();
    }
    // showEditUI 为 false 时也监听 editMode:changed，以便进入编辑模式时执行 initEditHistory 与快照逻辑（供 message-bridge 退出/保存用）
    if (config.showEditUI === false) {
        events.on('editMode:changed', updateEditModeUI);
        updateEditModeUI();
    }

    // Reveal / VFX、Lighting、PostEffect、VideoExport、Annotation 由独立组件管理，挂载到 edit-right-toolbar 提供的容器（showEditUI 为 false 时不挂载）
    if (config.showEditUI !== false) {
        initRevealUI(global);
        initVideoExportUI(global);
        initLightingUI(global);
        initPostEffectUI(global);
        initAnnotationUI(global);
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

    dom.info.addEventListener('click', () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('hidden');
    });

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('hidden');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel') {
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
    events.on('cameraMode:changed', () => {
        dom.orbitCamera.classList[state.cameraMode === 'orbit' ? 'add' : 'remove']('active');
        dom.flyCamera.classList[state.cameraMode === 'fly' ? 'add' : 'remove']('active');
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

    dom.reset.addEventListener('click', (event) => {
        events.fire('inputEvent', 'resetAnim', event);
    });

    dom.frame.addEventListener('click', (event) => {
        events.fire('inputEvent', 'frame', event);
    });

    dom.getCameraInfo.addEventListener('click', () => {
        events.fire('getCameraInfo');
    });

    // Joystick: when true, initJoystick registers visibility (fly+touch => show); when false, never show.
    const joystickEnabled = false; // false = 双指 fly 默认，不显示摇杆

    if (joystickEnabled) {
        initJoystick(dom, events, state);
        events.fire('joystickElementReady', dom.joystickBase);
    } else {
        // 不调用 initJoystick，避免其 updateJoystickVisibility 在 fly+touch 时去掉 hidden
        dom.joystickBase.classList.add('hidden');
        events.fire('joystickDisabled');
    }
    

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
    tooltip.register(dom.reset, 'Reset Camera', 'bottom');
    tooltip.register(dom.frame, 'Frame Scene', 'bottom');
    tooltip.register(dom.settings, 'Settings', 'top');
    tooltip.register(dom.info, 'Help', 'top');
    tooltip.register(dom.arMode, 'Enter AR', 'top');
    tooltip.register(dom.vrMode, 'Enter VR', 'top');
    tooltip.register(dom.enterFullscreen, 'Fullscreen', 'top');
    tooltip.register(dom.exitFullscreen, 'Fullscreen', 'top');
    tooltip.register(dom.saveSettingsBtn, 'Save Settings', 'top');
    tooltip.register(dom.undoEditBtn, 'Undo (Ctrl/Cmd+Z)', 'top');
    tooltip.register(dom.redoEditBtn, 'Redo (Ctrl/Cmd+Shift+Z)', 'top');

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

        (dom.supersplatBranding as HTMLAnchorElement).href = viewUrl.toString();
        dom.supersplatBranding.classList.remove('hidden');
    }
};

export { initPoster, initUI };
