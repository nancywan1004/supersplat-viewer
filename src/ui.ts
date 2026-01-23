import { EventHandler, Vec3 } from 'playcanvas';

import { Tooltip } from './tooltip';
import { Global } from './types';
import { isLodMetaFile } from './loaders/lod-loader';

const v = new Vec3();

// update the poster image to start blurry and then resolve to sharp during loading
const initPoster = (events: EventHandler) => {
    const poster = document.getElementById('poster');

    events.on('firstFrame', () => {
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
        'revealPanel', 'revealType', 'revealRestart',
        'skyboxRow', 'skyboxSelect',
        'reset', 'frame',
        'getCameraInfo',
        'loadingText', 'loadingBar',
        'joystickBase', 'joystick',
        'tooltip'
    ].reduce((acc: Record<string, HTMLElement>, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, {});

    // Check if LOD mode is enabled
    const isLodMode = config.contentUrl ? isLodMetaFile(config.contentUrl) : false;
    
    // In LOD mode, show progress bar but mark as 100% when animation starts
    // Progress is calculated based on threshold, reaching 100% when animation begins
    const hideProgressBarInLodMode = false;

    // Handle loading progress updates
    if (isLodMode && hideProgressBarInLodMode) {
        // Hide progress bar in LOD mode
        const loadingWrap = document.getElementById('loadingWrap');
        if (loadingWrap) {
            loadingWrap.classList.add('hidden');
        }
    } else {
        events.on('progress:changed', (progress) => {
            dom.loadingText.textContent = `${progress}%`;
            if (progress < 100) {
                dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, #F60 0%, #F60 ${progress}%, white ${progress}%, white 100%)`;
            } else {
                dom.loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 100%)';
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

    // Hide loading bar once first frame is rendered
    events.on('firstFrame', () => {
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
            document.exitFullscreen();
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

    // Reveal mode
    dom.revealType?.addEventListener('change', (event) => {
        const target = event.target as HTMLSelectElement;
        const revealType = target.value as 'radial' | 'rain' | 'smooth';
        events.fire('revealConfigChanged', { type: revealType });
    });

    dom.revealRestart?.addEventListener('click', () => {
        events.fire('revealRestart');
    });

    // Show/hide reveal controls based on hasRevealEffect state
    const updateRevealControls = () => {
        const hasReveal = state.hasRevealEffect;
        if (dom.revealPanel) {
            dom.revealPanel.classList[hasReveal ? 'remove' : 'add']('hidden');
            
            // Sync dropdown with current reveal effect type from settings
            if (hasReveal && dom.revealType && global.settings?.revealEffect?.type) {
                const currentType = global.settings.revealEffect.type;
                const selectElement = dom.revealType as HTMLSelectElement;
                if (selectElement.value !== currentType) {
                    selectElement.value = currentType;
                }
            }
        }
    };

    events.on('hasRevealEffect:changed', updateRevealControls);
    
    // Listen for reveal config changes to update UI
    events.on('revealConfigChanged', (newConfig) => {
        if (dom.revealType && newConfig.type) {
            (dom.revealType as HTMLSelectElement).value = newConfig.type;
        }
    });
    
    updateRevealControls();

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
            state.controlsHidden = true;
        }, 4000);
    };
    // Only show UI initially if noBottomUI is not enabled
    if (!config.noBottomUI) {
        showUI();
    }

    events.on('inputEvent', showUI);

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

    // update UI based on touch joystick updates
    events.on('touchJoystickUpdate', (base, stick) => {
        if (base === null || stick === null) {
            // Reset joystick to center when not in use
            dom.joystick.style.left = '48px';
            dom.joystick.style.top = '48px';
            dom.joystickBase.classList.remove('active');
        } else {
            v.set(stick[0], stick[1], 0).mulScalar(1 / 48);
            if (v.length() > 1) {
                v.normalize();
            }
            v.mulScalar(48);

            dom.joystickBase.classList.add('active');
            dom.joystick.style.left = `${48 + v.x}px`;
            dom.joystick.style.top = `${48 + v.y}px`;
        }
    });

    // Show joystick on touch devices and desktop (for debugging)
    // Always show joystick for better UX
    // Joystick visibility and functionality control
    const joystickEnabled = false; // Set to false to completely disable joystick
    
    if (joystickEnabled) {
        // Option 1: Always hide joystick UI (uncomment to use)
        // dom.joystickBase.classList.add('hidden');
        
        // Option 2: Show only on touch devices (uncomment to use)
        // if (state.inputMode === 'touch') {
        //     dom.joystickBase.classList.remove('hidden');
        // }
        
        // Option 3: Always show joystick (default - uncomment to use)
        dom.joystickBase.classList.remove('hidden');
        
        console.log('UI: Joystick element ready', dom.joystickBase);
        
        // Notify that joystick element is ready for attachment
        events.fire('joystickElementReady', dom.joystickBase);
        
        // Dynamic visibility based on input mode
        events.on('inputMode:changed', (mode) => {
            if (mode === 'touch') {
                dom.joystickBase.classList.remove('hidden');
            } else {
                // Uncomment to hide on desktop
                // dom.joystickBase.classList.add('hidden');
            }
        });
    } else {
        // Completely disable joystick (hide UI and disable functionality)
        dom.joystickBase.classList.add('hidden');
        events.fire('joystickDisabled');
    }
    

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
        } else {
            dom.cameraPathCheck.classList.add('hidden');
        }
    });

    // Camera bounding box visualization toggle (independent from camera path)
    dom.cameraBoundsOption.addEventListener('click', () => {
        state.showCameraBoundingBox = !state.showCameraBoundingBox;
    });

    events.on('showCameraBoundingBox:changed', (value) => {
        if (value) {
            dom.cameraBoundsCheck.classList.remove('hidden');
        } else {
            dom.cameraBoundsCheck.classList.add('hidden');
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
};

export { initPoster, initUI };
