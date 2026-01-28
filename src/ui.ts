import { EventHandler, Vec3, RenderTarget, Texture, PIXELFORMAT_RGBA8 } from 'playcanvas';

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
        'revealPanel', 'revealType', 'revealRestart', 'totalDurationRow', 'totalDuration',
        'effectTimelineRow', 'effectTimeline', 'effectPlayPause', 'effectTimeDisplay',
        'vfxVideoExportRow', 'vfxVideoExportButton', 'testCaptureFrameButton', 'videoResolution', 'customResolutionRow', 'customWidth', 'customHeight',
        'restartAnimTrackCheck', 'restartAnimTrackOption',
        'skyboxRow', 'skyboxSelect',
        'nightModeCheck', 'nightModeOption',
        'nightFadeSlider', 'nightFadeValue',
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

    // Night Mode Toggle and Intensity Slider
    const nightModeCheck = dom.nightModeCheck;
    const nightModeOption = dom.nightModeOption;
    const nightFadeSlider = dom.nightFadeSlider as HTMLInputElement;
    const nightFadeValue = dom.nightFadeValue;
    
    let nightModeEnabled = false;
    
    if (nightModeCheck && nightModeOption) {
        // Toggle night mode on/off
        const toggleNightMode = () => {
            nightModeEnabled = !nightModeEnabled;
            nightModeCheck.classList[nightModeEnabled ? 'remove' : 'add']('hidden');
            // Enable/disable slider based on night mode state
            if (nightFadeSlider) {
                nightFadeSlider.disabled = !nightModeEnabled;
            }
            // Fire toggle event
            events.fire('toggle:night-mode');
            global.app.fire('toggle:night-mode');
        };
        
        nightModeOption.addEventListener('click', toggleNightMode);
        nightModeCheck.addEventListener('click', toggleNightMode);
    }
    
    if (nightFadeSlider && nightFadeValue) {
        // Update slider value display (show 0-1 value)
        const updateSliderDisplay = (value: number) => {
            nightFadeSlider.value = value.toString();
            nightFadeValue.textContent = value.toFixed(2);
        };

        // Handle slider input
        nightFadeSlider.addEventListener('input', (event) => {
            const value = parseFloat((event.target as HTMLInputElement).value);
            updateSliderDisplay(value);
            // Fire on both event systems to ensure night-mode script receives it
            events.fire('nightFade:set', value);
            global.app.fire('nightFade:set', value);
        });

        // Sync slider with nightFade changes from night-mode script
        events.on('nightFade:changed', (value: number) => {
            updateSliderDisplay(value);
        });
        
        // Also listen to app events (in case night-mode fires on app)
        global.app.on('nightFade:changed', (value: number) => {
            updateSliderDisplay(value);
        });
        
        // Listen for night mode state changes to update toggle and slider
        global.app.on('nightMode:changed', (enabled: boolean) => {
            nightModeEnabled = enabled;
            if (nightModeCheck) {
                nightModeCheck.classList[enabled ? 'remove' : 'add']('hidden');
            }
            if (nightFadeSlider) {
                nightFadeSlider.disabled = !enabled;
                // When enabling, slider will be updated by nightFade:changed event
                // When disabling, keep slider at current value but disabled
            }
        });

        // Initialize slider to 0
        updateSliderDisplay(0);
        
        // Request initial nightFade value from night-mode script
        // This will be sent when night-mode script initializes
        setTimeout(() => {
            global.app.fire('nightFade:request');
        }, 100);
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

    // Reveal mode (now includes VFX effects)
    // 需要 totalDuration 的特效列表
    const timedVfxEffects = ['rain_v2', 'pieces-recover', 'integrate', 'growth-wave', 'sketch'];
    
    dom.revealType?.addEventListener('change', (event) => {
        const target = event.target as HTMLSelectElement;
        const revealType = target.value as 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none';
        
        events.fire('revealConfigChanged', { type: revealType });
    });

    // Total duration control
    dom.totalDuration?.addEventListener('change', (event) => {
        const target = event.target as HTMLInputElement;
        const totalDuration = parseFloat(target.value);
        if (!isNaN(totalDuration) && totalDuration > 0) {
            events.fire('revealConfigChanged', { totalDuration });
            // 更新时间轴 slider 的最大值
            if (dom.effectTimeline) {
                (dom.effectTimeline as HTMLInputElement).max = totalDuration.toString();
            }
        }
    });

    // Restart AnimTrack toggle
    let restartAnimTrackEnabled = false;
    const restartAnimTrackCheck = dom.restartAnimTrackCheck;
    const restartAnimTrackOption = dom.restartAnimTrackOption;
    
    if (restartAnimTrackCheck && restartAnimTrackOption) {
        const toggleRestartAnimTrack = () => {
            restartAnimTrackEnabled = !restartAnimTrackEnabled;
            restartAnimTrackCheck.classList[restartAnimTrackEnabled ? 'remove' : 'add']('hidden');
        };
        
        restartAnimTrackOption.addEventListener('click', toggleRestartAnimTrack);
        restartAnimTrackCheck.addEventListener('click', toggleRestartAnimTrack);
    }

    dom.revealRestart?.addEventListener('click', () => {
        events.fire('revealRestart', restartAnimTrackEnabled);
    });

    // 时间轴控制
    const effectTimeline = dom.effectTimeline as HTMLInputElement;
    const effectPlayPause = dom.effectPlayPause as HTMLButtonElement;
    const effectTimeDisplay = dom.effectTimeDisplay;
    let isDraggingTimeline = false;
    let wasPausedBeforeDrag = false;

    // 更新播放/暂停按钮显示
    const updatePlayPauseButton = (paused: boolean) => {
        if (effectPlayPause) {
            effectPlayPause.textContent = paused ? '▶' : '⏸';
        }
    };

    // 更新时间轴 slider 和时间显示
    const updateTimeline = (time: number, totalDuration: number) => {
        if (effectTimeline && !isDraggingTimeline) {
            // slider 使用整数步进，所以将时间（秒）乘以 10 转换为整数（0.1 秒精度）
            effectTimeline.value = (time * 10).toString();
            effectTimeline.max = (totalDuration * 10).toString();
        }
        if (effectTimeDisplay) {
            effectTimeDisplay.textContent = `${time.toFixed(1)}s`;
        }
    };

    // 播放/暂停按钮点击
    effectPlayPause?.addEventListener('click', () => {
        events.fire('effectPlayPause:toggle');
    });

    // 时间轴拖动开始
    effectTimeline?.addEventListener('pointerdown', () => {
        isDraggingTimeline = true;
        // 获取当前暂停状态（从 RevealController 获取，或使用事件）
        // 先暂停播放，保存之前的状态
        const currentPaused = (global.state as any).effectPaused ?? false;
        wasPausedBeforeDrag = currentPaused;
        // 暂停播放以便拖动
        events.fire('effectPlayPause:set', true);
    });

    // 时间轴拖动
    effectTimeline?.addEventListener('input', (event) => {
        const sliderValue = parseFloat((event.target as HTMLInputElement).value);
        const timeValue = sliderValue / 10; // 除以 10 因为 slider 使用 0.1 秒精度
        // 更新显示
        if (effectTimeDisplay) {
            effectTimeDisplay.textContent = `${timeValue.toFixed(1)}s`;
        }
        // 发送时间设置事件（这会触发特效时间更新）
        events.fire('effectTimeline:set', timeValue);
        // 同时触发时间变化事件，确保 UI 同步
        events.fire('effectTime:changed', timeValue);
    });

    // 时间轴拖动结束
    effectTimeline?.addEventListener('pointerup', () => {
        isDraggingTimeline = false;
        // 恢复之前的播放/暂停状态
        events.fire('effectPlayPause:set', wasPausedBeforeDrag);
    });

    // 监听时间变化事件
    events.on('effectTime:changed', (time: number) => {
        const totalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
        updateTimeline(time, totalDuration);
    });

    // 监听播放/暂停状态变化
    events.on('effectPlayPause:changed', (paused: boolean) => {
        updatePlayPauseButton(paused);
    });

    // 监听 totalDuration 变化，更新 slider 范围
    events.on('revealConfigChanged', (newConfig: any) => {
        if (newConfig.totalDuration !== undefined) {
            const totalDuration = newConfig.totalDuration;
            if (effectTimeline) {
                effectTimeline.max = (totalDuration * 10).toString();
                // 如果当前时间超过新的总时长，限制到最大值
                const currentValue = parseFloat(effectTimeline.value) / 10;
                if (currentValue > totalDuration) {
                    effectTimeline.value = (totalDuration * 10).toString();
                    events.fire('effectTimeline:set', totalDuration);
                }
            }
        }
    });

    // VFX 视频导出按钮（基于当前 VFX 时间轴）
    const vfxVideoExportRow = dom.vfxVideoExportRow;
    const vfxVideoExportButton = dom.vfxVideoExportButton as HTMLButtonElement;
    const videoResolution = dom.videoResolution as HTMLSelectElement;
    const customResolutionRow = dom.customResolutionRow;
    const customWidth = dom.customWidth as HTMLInputElement;
    const customHeight = dom.customHeight as HTMLInputElement;

    // 分辨率预设
    const resolutionPresets: Record<string, { width: number; height: number }> = {
        '720p': { width: 1280, height: 720 },
        '1080p': { width: 1920, height: 1080 },
        '1440p': { width: 2560, height: 1440 },
        '2160p': { width: 3840, height: 2160 }
    };

    // 根据分辨率选择显示/隐藏自定义分辨率输入
    const updateCustomResolutionVisibility = () => {
        if (videoResolution && customResolutionRow) {
            const isCustom = videoResolution.value === 'custom';
            customResolutionRow.classList[isCustom ? 'remove' : 'add']('hidden');
        }
    };

    videoResolution?.addEventListener('change', updateCustomResolutionVisibility);
    updateCustomResolutionVisibility();

    // 获取配置的分辨率
    const getVideoResolution = (): { width: number; height: number } => {
        const selected = videoResolution?.value || '1080p';
        
        if (selected === 'custom') {
            const width = parseInt(customWidth?.value || '1920', 10);
            const height = parseInt(customHeight?.value || '1080', 10);
            return { width, height };
        }
        
        return resolutionPresets[selected] || resolutionPresets['1080p'];
    };

    // 根据当前是否为需要时间轴的 VFX 效果来显示/隐藏导出按钮
    const updateVfxVideoExportVisibility = () => {
        const currentType = (state as any).vfxType || global.settings?.revealEffect?.type || 'none';
        const showForType = timedVfxEffects.includes(currentType);
        if (vfxVideoExportRow) {
            vfxVideoExportRow.classList[showForType ? 'remove' : 'add']('hidden');
        }
    };

    // 初始及配置变化时更新可见性
    events.on('revealType:changed', updateVfxVideoExportVisibility);
    events.on('revealConfigChanged', updateVfxVideoExportVisibility);
    updateVfxVideoExportVisibility();

    // 点击导出 VFX 视频
    vfxVideoExportButton?.addEventListener('click', async () => {
        try {
            // 获取配置的分辨率
            const resolution = getVideoResolution();
            // H264 编码器要求宽度和高度都是偶数
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            
            if (width !== resolution.width || height !== resolution.height) {
                console.log(`Video dimensions adjusted from ${resolution.width}x${resolution.height} to ${width}x${height} for H264 compatibility`);
            }

            // 使用 revealEffect 的 totalDuration 作为导出时长
            // 注意：导出将基于 VFX 时间轴，从 0 到 totalDuration
            const totalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
            const frameRate = 30;          // 输出视频帧率
            
            // 注意：startFrame 和 endFrame 现在不再使用，因为导出基于 VFX 时间轴
            // 但为了保持 VideoSettings 接口兼容性，仍然提供这些值
            const videoSettings = {
                startFrame: 0,
                endFrame: 0, // 不再使用，导出时长由 VFX 时间轴决定
                frameRate,
                width,
                height,
                bitrate: 8_000_000,
                transparentBg: false,
                showDebug: false,
                format: 'mov' as const,
                codec: 'h264' as const
            };

            let fileStream: FileSystemWritableFileStream | undefined;

            // 如果浏览器支持 File System Access API，则弹出保存对话框
            if ('showSaveFilePicker' in window) {
                const opts = {
                    types: [
                        {
                            description: 'Video File',
                            accept: {
                                'video/quicktime': ['.mov']
                            }
                        }
                    ],
                    suggestedName: 'vfx-timeline.mov'
                };
                const handle = await (window as any).showSaveFilePicker(opts);
                fileStream = await handle.createWritable();
            }

            // 触发视频渲染与编码
            events.fire('render.video', videoSettings, fileStream as any);
        } catch (err) {
            console.error('Failed to start VFX video export:', err);
        }
    });

    // 测试捕获单帧按钮
    const testCaptureFrameButton = dom.testCaptureFrameButton as HTMLButtonElement;
    testCaptureFrameButton?.addEventListener('click', async () => {
        try {
            const gd = global.app.graphicsDevice;
            const canvas = gd.canvas as HTMLCanvasElement;
            
            // 检查 canvas 是否存在和有效
            if (!canvas) {
                throw new Error('Canvas not found');
            }
            
            console.log('Canvas info:', {
                width: canvas.width,
                height: canvas.height,
                clientWidth: canvas.clientWidth,
                clientHeight: canvas.clientHeight,
                offsetWidth: canvas.offsetWidth,
                offsetHeight: canvas.offsetHeight,
                style: {
                    display: canvas.style.display,
                    visibility: canvas.style.visibility,
                    opacity: canvas.style.opacity
                }
            });
            
            // 获取配置的分辨率
            const resolution = getVideoResolution();
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            
            console.log(`Testing frame capture at ${width}x${height}`);
            console.log(`Source canvas size: ${canvas.width}x${canvas.height}`);
            
            // 如果 canvas 尺寸为 0，使用实际显示尺寸
            const sourceWidth = canvas.width || canvas.clientWidth || gd.width;
            const sourceHeight = canvas.height || canvas.clientHeight || gd.height;
            
            console.log(`Using source size: ${sourceWidth}x${sourceHeight}`);
            
            if (sourceWidth === 0 || sourceHeight === 0) {
                throw new Error(`Invalid canvas size: ${sourceWidth}x${sourceHeight}`);
            }
            
            // 等待多帧渲染完成，确保内容已渲染
            for (let i = 0; i < 3; i++) {
                await new Promise<void>((resolve) => {
                    global.app.once('frameend', () => {
                        resolve();
                    });
                    global.app.renderNextFrame = true;
                });
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            // 先尝试从 RenderTarget 捕获（优先方法）
            let capturedData: Uint8Array | null = null;
            let captureMethod = 'unknown';
            
            try {
                // 创建临时 RenderTarget 用于捕获
                const device = global.app.graphicsDevice;
                const tempColorBuffer = new Texture(device, {
                    format: PIXELFORMAT_RGBA8,
                    width: width,
                    height: height,
                    mipmaps: false
                });
                const tempRenderTarget = new RenderTarget({
                    colorBuffer: tempColorBuffer,
                    depth: false
                });
                
                // 保存原始渲染目标
                const originalRenderTarget = device.getRenderTarget();
                const originalCameraRenderTarget = (global.camera.camera as any).renderTarget;
                
                try {
                    // 设置渲染目标
                    device.setRenderTarget(tempRenderTarget);
                    if (originalCameraRenderTarget !== undefined) {
                        (global.camera.camera as any).renderTarget = tempRenderTarget;
                    }
                    
                    // 触发渲染
                    global.app.renderNextFrame = true;
                    await new Promise<void>((resolve) => {
                        global.app.once('frameend', () => {
                            resolve();
                        });
                    });
                    
                    // 读取数据
                    const data = await tempColorBuffer.read(0, 0, width, height, { renderTarget: tempRenderTarget });
                    
                    if (data instanceof Uint8Array) {
                        capturedData = data;
                        captureMethod = 'RenderTarget (direct render, Uint8Array)';
                    } else if (data instanceof Float32Array) {
                        capturedData = new Uint8Array(data.length);
                        for (let i = 0; i < data.length; i++) {
                            capturedData[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                        }
                        captureMethod = 'RenderTarget (direct render, Float32Array converted)';
                    }
                    
                    // 恢复原始渲染目标
                    device.setRenderTarget(originalRenderTarget);
                    if (originalCameraRenderTarget !== undefined) {
                        (global.camera.camera as any).renderTarget = originalCameraRenderTarget;
                    }
                    
                    // 清理临时资源
                    tempRenderTarget.destroy();
                    tempColorBuffer.destroy();
                } catch (renderError) {
                    // 确保恢复
                    device.setRenderTarget(originalRenderTarget);
                    if (originalCameraRenderTarget !== undefined) {
                        (global.camera.camera as any).renderTarget = originalCameraRenderTarget;
                    }
                    tempRenderTarget.destroy();
                    tempColorBuffer.destroy();
                    throw renderError;
                }
            } catch (rtError) {
                console.warn('RenderTarget capture failed, trying canvas method:', rtError);
            }
            
            // 如果 RenderTarget 方法失败，使用 canvas 方法
            if (!capturedData) {
                // 创建离屏 canvas 用于捕获
                const offscreenCanvas = document.createElement('canvas');
                offscreenCanvas.width = width;
                offscreenCanvas.height = height;
                const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
                
                if (!ctx) {
                    throw new Error('Failed to get 2d context');
                }
                
                // 先尝试直接绘制 canvas
                try {
                    ctx.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
                    captureMethod = 'Canvas (drawImage)';
                } catch (drawError) {
                    console.warn('Direct drawImage failed, trying toDataURL method:', drawError);
                    // 如果直接绘制失败，尝试使用 toDataURL
                    try {
                        const dataUrl = canvas.toDataURL('image/png');
                        const img = new Image();
                        await new Promise((resolve, reject) => {
                            img.onload = resolve;
                            img.onerror = reject;
                            img.src = dataUrl;
                        });
                        ctx.drawImage(img, 0, 0, width, height);
                        captureMethod = 'Canvas (toDataURL)';
                    } catch (dataUrlError) {
                        console.error('toDataURL method also failed:', dataUrlError);
                        throw new Error(`Failed to capture canvas: ${drawError}, ${dataUrlError}`);
                    }
                }
                
                // 从 canvas 读取像素数据
                const imageData = ctx.getImageData(0, 0, width, height);
                capturedData = new Uint8Array(imageData.data);
            }
            
            // 检查是否有内容（不是全黑）
            let hasContent = false;
            let maxR = 0, maxG = 0, maxB = 0;
            let sampleCount = 0;
            for (let i = 0; i < capturedData.length; i += 4) {
                const r = capturedData[i];
                const g = capturedData[i + 1];
                const b = capturedData[i + 2];
                maxR = Math.max(maxR, r);
                maxG = Math.max(maxG, g);
                maxB = Math.max(maxB, b);
                if (r > 10 || g > 10 || b > 10) {
                    hasContent = true;
                }
                sampleCount++;
                if (sampleCount > 10000) break; // 只检查前10000个像素
            }
            
            console.log(`Frame capture test: ${hasContent ? 'SUCCESS - Content detected' : 'FAILED - Black screen detected'}`);
            console.log(`Capture method: ${captureMethod}`);
            console.log(`Max RGB values: R=${maxR}, G=${maxG}, B=${maxB}`);
            
            // 创建 canvas 用于显示
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = width;
            offscreenCanvas.height = height;
            const ctx = offscreenCanvas.getContext('2d');
            if (ctx) {
                // 垂直翻转数据（因为 Canvas 和视频帧的坐标系不同）
                const flippedData = new Uint8ClampedArray(capturedData.length);
                for (let y = 0; y < height; y++) {
                    const srcY = height - 1 - y;
                    const srcOffset = srcY * width * 4;
                    const dstOffset = y * width * 4;
                    flippedData.set(capturedData.subarray(srcOffset, srcOffset + width * 4), dstOffset);
                }
                
                const imageData = ctx.createImageData(width, height);
                imageData.data.set(flippedData);
                ctx.putImageData(imageData, 0, 0);
            }
            
            // 将捕获的图像显示在新窗口中
            const dataUrl = offscreenCanvas.toDataURL('image/png');
            const newWindow = window.open();
            if (newWindow) {
                newWindow.document.write(`
                    <html>
                        <head><title>Captured Frame Test</title></head>
                        <body style="margin: 0; padding: 20px; background: #333; color: white;">
                            <h2>捕获的帧测试 (${width}×${height})</h2>
                            <p>状态: <strong style="color: ${hasContent ? 'green' : 'red'}">${hasContent ? '成功 - 检测到内容' : '失败 - 黑屏'}</strong></p>
                            <p>最大 RGB 值: R=${maxR}, G=${maxG}, B=${maxB}</p>
                            <img src="${dataUrl}" style="max-width: 100%; border: 2px solid ${hasContent ? 'green' : 'red'};" />
                            <p style="margin-top: 20px; font-size: 12px; color: #999;">
                                捕获方法: ${captureMethod}<br>
                                源 canvas 尺寸: ${canvas.width}×${canvas.height}<br>
                                源显示尺寸: ${sourceWidth}×${sourceHeight}<br>
                                捕获尺寸: ${width}×${height}<br>
                                GraphicsDevice: ${gd.width}×${gd.height}
                            </p>
                        </body>
                    </html>
                `);
            } else {
                // 如果弹窗被阻止，使用 alert 显示结果
                alert(`捕获测试完成！\n状态: ${hasContent ? '成功 - 检测到内容' : '失败 - 黑屏'}\n尺寸: ${width}×${height}\n最大RGB: R=${maxR}, G=${maxG}, B=${maxB}`);
            }
        } catch (err) {
            console.error('Failed to test frame capture:', err);
            alert(`捕获测试失败: ${err}`);
        }
    });

    // Show/hide reveal controls (always show now since it includes VFX)
    const updateRevealControls = () => {
        // Reveal panel always visible (includes VFX effects)
        if (dom.revealPanel) {
            dom.revealPanel.classList.remove('hidden');
            
            // Sync dropdown with current effect type
            if (dom.revealType) {
                const currentType = (state as any).vfxType || global.settings?.revealEffect?.type || 'none';
                const selectElement = dom.revealType as HTMLSelectElement;
                if (selectElement.value !== currentType) {
                    selectElement.value = currentType;
                }
                
                // Show/hide totalDuration control based on selected effect
                const showTotalDuration = timedVfxEffects.includes(currentType);
                if (dom.totalDurationRow) {
                    if (showTotalDuration) {
                        dom.totalDurationRow.classList.remove('hidden');
                        // Sync totalDuration value
                        const currentTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
                        if (dom.totalDuration) {
                            (dom.totalDuration as HTMLInputElement).value = currentTotalDuration.toString();
                        }
                    } else {
                        dom.totalDurationRow.classList.add('hidden');
                    }
                }
                
                // Show/hide timeline control based on selected effect
                const showTimeline = timedVfxEffects.includes(currentType);
                if (dom.effectTimelineRow) {
                    if (showTimeline) {
                        dom.effectTimelineRow.classList.remove('hidden');
                        // Sync timeline max value and reset to 0
                        const currentTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
                        if (dom.effectTimeline) {
                            const timelineEl = dom.effectTimeline as HTMLInputElement;
                            timelineEl.max = (currentTotalDuration * 10).toString();
                            timelineEl.value = '0';
                        }
                        if (dom.effectTimeDisplay) {
                            dom.effectTimeDisplay.textContent = '0.0s';
                        }
                    } else {
                        dom.effectTimelineRow.classList.add('hidden');
                    }
                }
            }
        }
    };

    events.on('hasRevealEffect:changed', updateRevealControls);
    
    // 统一监听 reveal 类型变化和配置变化
    events.on('revealType:changed', (type: string) => {
        if (dom.revealType) {
            (dom.revealType as HTMLSelectElement).value = type;
        }
        updateRevealControls();
    });
    
    // 监听配置变化（包括类型和启用状态）
    events.on('revealConfigChanged', (newConfig: any) => {
        if (dom.revealType && newConfig.type) {
            (dom.revealType as HTMLSelectElement).value = newConfig.type;
        }
        updateRevealControls();
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
